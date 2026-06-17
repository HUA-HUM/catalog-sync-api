import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  AnalyticsDateRange,
  IAnalyticsRepository,
  ProductPerformanceQuery,
} from 'src/core/adapters/postgres/analytics/IAnalyticsRepository';

@Injectable()
export class PostgresAnalyticsRepository implements IAnalyticsRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async getCatalogSummary(): Promise<unknown> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*)::int AS total_items,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_items,
        COUNT(*) FILTER (WHERE status = 'paused')::int AS paused_items,
        COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_items,
        COUNT(*) FILTER (WHERE COALESCE(stock, 0) > 0)::int AS items_with_stock,
        COUNT(*) FILTER (WHERE COALESCE(stock, 0) <= 0)::int AS items_without_stock,
        COALESCE(SUM(stock), 0)::int AS total_stock,
        COALESCE(SUM(sold_quantity), 0)::int AS total_sold_quantity,
        ROUND(AVG(price), 2)::numeric AS avg_price,
        COALESCE(SUM(price * COALESCE(stock, 0)), 0)::numeric AS catalog_stock_value,
        COUNT(DISTINCT category_id)::int AS categories_count,
        COUNT(DISTINCT brand)::int AS brands_count,
        COUNT(*) FILTER (WHERE date_created >= now() - interval '7 days')::int AS created_last_7_days,
        COUNT(*) FILTER (WHERE last_synced_at >= now() - interval '1 day')::int AS synced_last_24_hours
      FROM meli_items
    `);

    return result.rows[0];
  }

  async getTableFreshness(staleAfterHours: number): Promise<unknown> {
    const metadata = await this.pool.query<{
      schema_name: string;
      table_name: string;
      relation_type: 'table' | 'materialized_view';
      estimated_rows: string;
      timestamp_column: string | null;
    }>(`
      WITH relations AS (
        SELECT
          namespace.nspname AS schema_name,
          relation.relname AS table_name,
          CASE relation.relkind
            WHEN 'm' THEN 'materialized_view'
            ELSE 'table'
          END AS relation_type,
          GREATEST(relation.reltuples, 0)::bigint AS estimated_rows,
          relation.oid AS relation_oid
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'analytics')
          AND relation.relkind IN ('r', 'p', 'm')
      ),
      timestamp_columns AS (
        SELECT
          relations.relation_oid,
          attribute.attname AS timestamp_column,
          ROW_NUMBER() OVER (
            PARTITION BY relations.relation_oid
            ORDER BY CASE attribute.attname
              WHEN 'last_synced_at' THEN 1
              WHEN 'synced_at' THEN 2
              WHEN 'captured_at' THEN 3
              WHEN 'updated_at' THEN 4
              WHEN 'last_updated' THEN 5
              WHEN 'created_at' THEN 6
              WHEN 'date_closed' THEN 7
              WHEN 'date_created' THEN 8
              ELSE 100
            END
          ) AS priority
        FROM relations
        JOIN pg_attribute attribute
          ON attribute.attrelid = relations.relation_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        JOIN pg_type column_type ON column_type.oid = attribute.atttypid
        WHERE column_type.typname IN ('timestamp', 'timestamptz', 'date')
          AND attribute.attname IN (
            'last_synced_at',
            'synced_at',
            'captured_at',
            'updated_at',
            'last_updated',
            'created_at',
            'date_closed',
            'date_created'
          )
      )
      SELECT
        relations.schema_name,
        relations.table_name,
        relations.relation_type,
        relations.estimated_rows::text,
        timestamp_columns.timestamp_column
      FROM relations
      LEFT JOIN timestamp_columns
        ON timestamp_columns.relation_oid = relations.relation_oid
       AND timestamp_columns.priority = 1
      ORDER BY relations.schema_name, relations.table_name
    `);

    const generatedAt = new Date();
    const staleBefore = new Date(
      generatedAt.getTime() - staleAfterHours * 60 * 60 * 1000,
    );

    const tables = await Promise.all(
      metadata.rows.map(async (relation) => {
        const base = {
          schema: relation.schema_name,
          table: relation.table_name,
          relation_type: relation.relation_type,
          estimated_rows: Number(relation.estimated_rows),
          timestamp_column: relation.timestamp_column,
        };

        if (!relation.timestamp_column) {
          return {
            ...base,
            last_update: null,
            age_hours: null,
            status: Number(relation.estimated_rows) > 0 ? 'untracked' : 'empty',
          };
        }

        try {
          const schema = this.quoteIdentifier(relation.schema_name);
          const table = this.quoteIdentifier(relation.table_name);
          const timestampColumn = this.quoteIdentifier(
            relation.timestamp_column,
          );
          const result = await this.pool.query<{ last_update: Date | null }>(
            `SELECT MAX(${timestampColumn}) AS last_update FROM ${schema}.${table}`,
          );
          const lastUpdate = result.rows[0]?.last_update ?? null;
          const ageHours = lastUpdate
            ? (generatedAt.getTime() - new Date(lastUpdate).getTime()) / 3600000
            : null;

          return {
            ...base,
            last_update: lastUpdate,
            age_hours:
              ageHours === null
                ? null
                : Number(Math.max(ageHours, 0).toFixed(2)),
            status:
              lastUpdate === null
                ? 'empty'
                : new Date(lastUpdate) < staleBefore
                  ? 'stale'
                  : 'fresh',
          };
        } catch (error) {
          return {
            ...base,
            last_update: null,
            age_hours: null,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return {
      generated_at: generatedAt,
      stale_after_hours: staleAfterHours,
      summary: {
        total: tables.length,
        fresh: tables.filter((table) => table.status === 'fresh').length,
        stale: tables.filter((table) => table.status === 'stale').length,
        empty: tables.filter((table) => table.status === 'empty').length,
        untracked: tables.filter((table) => table.status === 'untracked')
          .length,
        errors: tables.filter((table) => table.status === 'error').length,
      },
      tables,
    };
  }

  async getCategoryTree(): Promise<unknown> {
    const result = await this.pool.query(`
      WITH category_stats AS (
        SELECT
          category_id,
          domain_id,
          COUNT(*)::int AS items_count,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_items,
          COUNT(DISTINCT brand)::int AS brands_count,
          COALESCE(SUM(stock), 0)::int AS total_stock,
          COALESCE(SUM(sold_quantity), 0)::int AS sold_quantity,
          ROUND(AVG(price), 2)::numeric AS avg_price
        FROM meli_items
        WHERE category_id IS NOT NULL
        GROUP BY category_id, domain_id
      ),
      category_sales AS (
        SELECT
          i.category_id,
          COUNT(DISTINCT oi.order_id)::int AS orders_count,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
        FROM meli_order_items oi
        JOIN meli_items i
          ON i.seller_id = oi.seller_id
         AND i.item_id = oi.item_id
        GROUP BY i.category_id
      ),
      category_visits AS (
        SELECT
          i.category_id,
          COALESCE(SUM(v.total_visits), 0)::int AS visits
        FROM meli_item_visits_current v
        JOIN meli_items i
          ON i.seller_id = v.seller_id
         AND i.item_id = v.item_id
        GROUP BY i.category_id
      )
      SELECT
        cs.category_id,
        cs.domain_id,
        cs.items_count,
        cs.active_items,
        cs.brands_count,
        cs.total_stock,
        cs.sold_quantity,
        cs.avg_price,
        COALESCE(s.orders_count, 0)::int AS orders_count,
        COALESCE(s.units_sold, 0)::int AS ordered_units,
        COALESCE(s.revenue, 0)::numeric AS revenue,
        COALESCE(v.visits, 0)::int AS visits
      FROM category_stats cs
      LEFT JOIN category_sales s ON s.category_id = cs.category_id
      LEFT JOIN category_visits v ON v.category_id = cs.category_id
      ORDER BY cs.items_count DESC
    `);

    return {
      note: 'Este endpoint agrupa por category_id/domain_id. Para arbol real con nombres y padres hace falta persistir metadata de categorias de Meli.',
      categories: result.rows,
    };
  }

  async getCategoryPerformance(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        i.category_id,
        i.domain_id,
        COUNT(DISTINCT i.item_id)::int AS items_count,
        COUNT(DISTINCT oi.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue,
        COALESCE(MAX(v.total_visits), 0)::int AS sample_max_item_visits,
        ROUND(
          CASE
            WHEN COALESCE(SUM(v.total_visits), 0) = 0 THEN 0
            ELSE (COUNT(DISTINCT oi.order_id)::numeric / SUM(v.total_visits)) * 100
          END,
          4
        )::numeric AS order_conversion_rate
      FROM meli_items i
      LEFT JOIN meli_order_items oi
        ON oi.seller_id = i.seller_id
       AND oi.item_id = i.item_id
      LEFT JOIN meli_orders o
        ON o.seller_id = oi.seller_id
       AND o.order_id = oi.order_id
       AND o.date_closed >= $1
       AND o.date_closed < $2
      LEFT JOIN meli_item_visits_current v
        ON v.seller_id = i.seller_id
       AND v.item_id = i.item_id
      WHERE i.category_id IS NOT NULL
        AND (o.order_id IS NOT NULL OR oi.order_id IS NULL)
      GROUP BY i.category_id, i.domain_id
      ORDER BY revenue DESC, items_count DESC
      LIMIT 500
      `,
      [range.from, range.to],
    );

    return { range, categories: result.rows };
  }

  async getBrandSummary(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        COALESCE(i.brand, 'SIN_MARCA') AS brand,
        COUNT(DISTINCT i.item_id)::int AS items_count,
        COUNT(DISTINCT i.category_id)::int AS categories_count,
        COUNT(*) FILTER (WHERE i.status = 'active')::int AS active_items,
        COALESCE(SUM(i.stock), 0)::int AS total_stock,
        COALESCE(SUM(i.sold_quantity), 0)::int AS catalog_sold_quantity,
        COALESCE(SUM(v.total_visits), 0)::int AS visits,
        COUNT(DISTINCT o.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
      FROM meli_items i
      LEFT JOIN meli_item_visits_current v
        ON v.seller_id = i.seller_id
       AND v.item_id = i.item_id
      LEFT JOIN meli_order_items oi
        ON oi.seller_id = i.seller_id
       AND oi.item_id = i.item_id
      LEFT JOIN meli_orders o
        ON o.seller_id = oi.seller_id
       AND o.order_id = oi.order_id
       AND o.date_closed >= $1
       AND o.date_closed < $2
      GROUP BY COALESCE(i.brand, 'SIN_MARCA')
      ORDER BY items_count DESC
      LIMIT 500
      `,
      [range.from, range.to],
    );

    return { range, brands: result.rows };
  }

  async getBrandOrders(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        COALESCE(i.brand, 'SIN_MARCA') AS brand,
        COUNT(DISTINCT i.item_id)::int AS products_with_orders,
        COUNT(DISTINCT o.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
      FROM meli_orders o
      JOIN meli_order_items oi
        ON oi.seller_id = o.seller_id
       AND oi.order_id = o.order_id
      JOIN meli_items i
        ON i.seller_id = oi.seller_id
       AND i.item_id = oi.item_id
      WHERE o.date_closed >= $1
        AND o.date_closed < $2
      GROUP BY COALESCE(i.brand, 'SIN_MARCA')
      ORDER BY products_with_orders DESC, revenue DESC
      LIMIT 500
      `,
      [range.from, range.to],
    );

    return { range, brands: result.rows };
  }

  async getOrdersSummary(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        COUNT(DISTINCT o.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue,
        ROUND(AVG(o.total_amount), 2)::numeric AS avg_order_value,
        COUNT(DISTINCT oi.item_id)::int AS products_with_orders
      FROM meli_orders o
      LEFT JOIN meli_order_items oi
        ON oi.seller_id = o.seller_id
       AND oi.order_id = o.order_id
      WHERE o.date_closed >= $1
        AND o.date_closed < $2
      `,
      [range.from, range.to],
    );

    return { range, summary: result.rows[0] };
  }

  async getOrdersBySku(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        COALESCE(i.seller_sku, i.seller_custom_field, 'SIN_SKU') AS sku,
        i.item_id,
        MAX(i.title) AS title,
        MAX(i.brand) AS brand,
        MAX(i.category_id) AS category_id,
        COUNT(DISTINCT o.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
      FROM meli_orders o
      JOIN meli_order_items oi
        ON oi.seller_id = o.seller_id
       AND oi.order_id = o.order_id
      JOIN meli_items i
        ON i.seller_id = oi.seller_id
       AND i.item_id = oi.item_id
      WHERE o.date_closed >= $1
        AND o.date_closed < $2
      GROUP BY COALESCE(i.seller_sku, i.seller_custom_field, 'SIN_SKU'), i.item_id
      ORDER BY revenue DESC, units_sold DESC
      LIMIT 1000
      `,
      [range.from, range.to],
    );

    return { range, skus: result.rows };
  }

  async getTopVisitedProducts(limit: number): Promise<unknown> {
    const result = await this.pool.query(
      `
      SELECT
        i.item_id,
        i.title,
        i.brand,
        i.category_id,
        i.price,
        i.stock,
        v.total_visits,
        i.sold_quantity,
        COUNT(DISTINCT oi.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS ordered_units
      FROM meli_item_visits_current v
      JOIN meli_items i
        ON i.seller_id = v.seller_id
       AND i.item_id = v.item_id
      LEFT JOIN meli_order_items oi
        ON oi.seller_id = i.seller_id
       AND oi.item_id = i.item_id
      GROUP BY i.item_id, i.title, i.brand, i.category_id, i.price, i.stock, v.total_visits, i.sold_quantity
      ORDER BY v.total_visits DESC
      LIMIT $1
      `,
      [limit],
    );

    return { products: result.rows };
  }

  async getConversionByCategory(params: AnalyticsDateRange): Promise<unknown> {
    const range = this.buildDateRange(params);
    const result = await this.pool.query(
      `
      SELECT
        i.category_id,
        i.domain_id,
        COALESCE(SUM(v.total_visits), 0)::int AS visits,
        COUNT(DISTINCT o.order_id)::int AS orders_count,
        COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue,
        ROUND(
          CASE
            WHEN COALESCE(SUM(v.total_visits), 0) = 0 THEN 0
            ELSE (COUNT(DISTINCT o.order_id)::numeric / SUM(v.total_visits)) * 100
          END,
          4
        )::numeric AS order_conversion_rate
      FROM meli_items i
      LEFT JOIN meli_item_visits_current v
        ON v.seller_id = i.seller_id
       AND v.item_id = i.item_id
      LEFT JOIN meli_order_items oi
        ON oi.seller_id = i.seller_id
       AND oi.item_id = i.item_id
      LEFT JOIN meli_orders o
        ON o.seller_id = oi.seller_id
       AND o.order_id = oi.order_id
       AND o.date_closed >= $1
       AND o.date_closed < $2
      WHERE i.category_id IS NOT NULL
      GROUP BY i.category_id, i.domain_id
      ORDER BY visits DESC
      LIMIT 500
      `,
      [range.from, range.to],
    );

    return { range, categories: result.rows };
  }

  async getCatalogAge(): Promise<unknown> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE date_created >= now() - interval '7 days')::int AS created_last_7_days,
        COUNT(*) FILTER (WHERE date_created >= now() - interval '30 days')::int AS created_last_30_days,
        COUNT(*) FILTER (WHERE date_created >= now() - interval '90 days')::int AS created_last_90_days,
        COUNT(*) FILTER (WHERE date_created < now() - interval '365 days')::int AS older_than_1_year,
        MIN(date_created) AS oldest_publication,
        MAX(date_created) AS newest_publication
      FROM meli_items
    `);

    return result.rows[0];
  }

  async getMissingData(): Promise<unknown> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE brand IS NULL OR brand = '')::int AS without_brand,
        COUNT(*) FILTER (WHERE seller_sku IS NULL OR seller_sku = '')::int AS without_sku,
        COUNT(*) FILTER (WHERE category_id IS NULL OR category_id = '')::int AS without_category,
        COUNT(*) FILTER (WHERE raw IS NULL)::int AS without_raw,
        COUNT(*) FILTER (WHERE last_synced_at IS NULL)::int AS never_synced,
        (
          SELECT COUNT(*)
          FROM meli_items i
          LEFT JOIN meli_item_details d
            ON d.seller_id = i.seller_id
           AND d.item_id = i.item_id
          WHERE d.item_id IS NULL
        )::int AS without_details,
        (
          SELECT COUNT(*)
          FROM meli_items i
          LEFT JOIN meli_item_visits_current v
            ON v.seller_id = i.seller_id
           AND v.item_id = i.item_id
          WHERE v.item_id IS NULL
        )::int AS without_visits
      FROM meli_items
    `);

    return result.rows[0];
  }

  async getProductPerformance(
    params: ProductPerformanceQuery,
  ): Promise<unknown> {
    const filters: string[] = [];
    const values: unknown[] = [];

    const addFilter = (
      sql: (placeholder: string) => string,
      value: unknown,
    ) => {
      values.push(value);
      filters.push(sql(`$${values.length}`));
    };

    if (params.search) {
      addFilter(
        (p) =>
          `POSITION(LOWER(${p}) IN LOWER(CONCAT_WS(' ', item_id, title, sku, brand, category_id, domain_id))) > 0`,
        params.search,
      );
    }
    if (params.sellerId !== undefined)
      addFilter((p) => `seller_id = ${p}`, params.sellerId);
    if (params.itemId) addFilter((p) => `item_id = ${p}`, params.itemId);
    if (params.sku) addFilter((p) => `sku = ${p}`, params.sku);
    if (params.skuPrefix)
      addFilter((p) => `sku ILIKE ${p} || '%'`, params.skuPrefix);
    if (params.brands)
      addFilter((p) => `brand = ANY(${p}::text[])`, params.brands);
    if (params.categoryIds)
      addFilter((p) => `category_id = ANY(${p}::text[])`, params.categoryIds);
    if (params.domainIds)
      addFilter((p) => `domain_id = ANY(${p}::text[])`, params.domainIds);
    if (params.listingTypeIds)
      addFilter(
        (p) => `listing_type_id = ANY(${p}::text[])`,
        params.listingTypeIds,
      );
    if (params.statuses)
      addFilter((p) => `status = ANY(${p}::text[])`, params.statuses);
    if (params.conditions)
      addFilter((p) => `condition = ANY(${p}::text[])`, params.conditions);
    if (params.currencyId)
      addFilter((p) => `currency_id = ${p}`, params.currencyId);
    if (params.createdFrom)
      addFilter((p) => `date_created >= ${p}::timestamptz`, params.createdFrom);
    if (params.createdTo)
      addFilter((p) => `date_created <= ${p}::timestamptz`, params.createdTo);
    if (params.firstOrderFrom)
      addFilter(
        (p) => `first_order_date >= ${p}::timestamptz`,
        params.firstOrderFrom,
      );
    if (params.firstOrderTo)
      addFilter(
        (p) => `first_order_date <= ${p}::timestamptz`,
        params.firstOrderTo,
      );
    if (params.lastOrderFrom)
      addFilter(
        (p) => `last_order_date >= ${p}::timestamptz`,
        params.lastOrderFrom,
      );
    if (params.lastOrderTo)
      addFilter(
        (p) => `last_order_date <= ${p}::timestamptz`,
        params.lastOrderTo,
      );
    if (params.minPrice !== undefined)
      addFilter((p) => `price >= ${p}`, params.minPrice);
    if (params.maxPrice !== undefined)
      addFilter((p) => `price <= ${p}`, params.maxPrice);
    if (params.minStock !== undefined)
      addFilter((p) => `stock >= ${p}`, params.minStock);
    if (params.maxStock !== undefined)
      addFilter((p) => `stock <= ${p}`, params.maxStock);
    if (params.minAvailableQuantity !== undefined)
      addFilter(
        (p) => `available_quantity >= ${p}`,
        params.minAvailableQuantity,
      );
    if (params.maxAvailableQuantity !== undefined)
      addFilter(
        (p) => `available_quantity <= ${p}`,
        params.maxAvailableQuantity,
      );
    if (params.minCatalogSoldQuantity !== undefined)
      addFilter(
        (p) => `catalog_sold_quantity >= ${p}`,
        params.minCatalogSoldQuantity,
      );
    if (params.maxCatalogSoldQuantity !== undefined)
      addFilter(
        (p) => `catalog_sold_quantity <= ${p}`,
        params.maxCatalogSoldQuantity,
      );
    if (params.minVisits !== undefined)
      addFilter((p) => `total_visits >= ${p}`, params.minVisits);
    if (params.maxVisits !== undefined)
      addFilter((p) => `total_visits <= ${p}`, params.maxVisits);
    if (params.minOrders !== undefined)
      addFilter((p) => `orders_count >= ${p}`, params.minOrders);
    if (params.maxOrders !== undefined)
      addFilter((p) => `orders_count <= ${p}`, params.maxOrders);
    if (params.minUnitsSold !== undefined)
      addFilter((p) => `units_sold >= ${p}`, params.minUnitsSold);
    if (params.maxUnitsSold !== undefined)
      addFilter((p) => `units_sold <= ${p}`, params.maxUnitsSold);
    if (params.minRevenue !== undefined)
      addFilter((p) => `revenue >= ${p}`, params.minRevenue);
    if (params.maxRevenue !== undefined)
      addFilter((p) => `revenue <= ${p}`, params.maxRevenue);
    if (params.minAvgTicket !== undefined)
      addFilter((p) => `avg_ticket >= ${p}`, params.minAvgTicket);
    if (params.maxAvgTicket !== undefined)
      addFilter((p) => `avg_ticket <= ${p}`, params.maxAvgTicket);
    if (params.minDaysToFirstOrder !== undefined) {
      addFilter(
        (p) => `days_to_first_order >= ${p}`,
        params.minDaysToFirstOrder,
      );
    }
    if (params.maxDaysToFirstOrder !== undefined) {
      addFilter(
        (p) => `days_to_first_order <= ${p}`,
        params.maxDaysToFirstOrder,
      );
    }
    if (params.minOrderConversionRate !== undefined)
      addFilter(
        (p) => `order_conversion_rate >= ${p}`,
        params.minOrderConversionRate,
      );
    if (params.maxOrderConversionRate !== undefined)
      addFilter(
        (p) => `order_conversion_rate <= ${p}`,
        params.maxOrderConversionRate,
      );
    if (params.minUnitConversionRate !== undefined)
      addFilter(
        (p) => `unit_conversion_rate >= ${p}`,
        params.minUnitConversionRate,
      );
    if (params.maxUnitConversionRate !== undefined)
      addFilter(
        (p) => `unit_conversion_rate <= ${p}`,
        params.maxUnitConversionRate,
      );
    if (params.hasOrders !== undefined) {
      filters.push(
        params.hasOrders ? 'orders_count > 0' : 'COALESCE(orders_count, 0) = 0',
      );
    }
    if (params.hasVisits !== undefined) {
      filters.push(
        params.hasVisits ? 'total_visits > 0' : 'COALESCE(total_visits, 0) = 0',
      );
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sortColumns: Record<ProductPerformanceQuery['sortBy'], string> = {
      itemId: 'item_id',
      title: 'title',
      sku: 'sku',
      brand: 'brand',
      categoryId: 'category_id',
      domainId: 'domain_id',
      listingTypeId: 'listing_type_id',
      status: 'status',
      price: 'price',
      stock: 'stock',
      availableQuantity: 'available_quantity',
      catalogSoldQuantity: 'catalog_sold_quantity',
      dateCreated: 'date_created',
      lastUpdated: 'last_updated',
      totalVisits: 'total_visits',
      ordersCount: 'orders_count',
      unitsSold: 'units_sold',
      revenue: 'revenue',
      avgTicket: 'avg_ticket',
      firstOrderDate: 'first_order_date',
      lastOrderDate: 'last_order_date',
      daysToFirstOrder: 'days_to_first_order',
      orderConversionRate: 'order_conversion_rate',
      unitConversionRate: 'unit_conversion_rate',
    };
    const sortColumn = sortColumns[params.sortBy];
    const sortOrder = params.sortOrder.toUpperCase();
    const pageValues = [...values, params.limit, params.offset];
    const productPerformanceSource = `
      (
        SELECT
          pp.*,
          i.listing_type_id
        FROM analytics.product_performance pp
        LEFT JOIN public.meli_items i
          ON i.seller_id = pp.seller_id
         AND i.item_id = pp.item_id
      ) product_performance
    `;

    const [countResult, productsResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS total FROM ${productPerformanceSource} ${whereSql}`,
        values,
      ),
      this.pool.query(
        `
      SELECT *
      FROM ${productPerformanceSource}
      ${whereSql}
      ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, item_id ASC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
      `,
        pageValues,
      ),
    ]);

    const total = countResult.rows[0].total as number;

    return {
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        page: Math.floor(params.offset / params.limit) + 1,
        total_pages: Math.ceil(total / params.limit),
        has_next: params.offset + params.limit < total,
        has_previous: params.offset > 0,
      },
      sort: {
        by: params.sortBy,
        order: params.sortOrder,
      },
      products: productsResult.rows,
    };
  }

  private buildDateRange(params: AnalyticsDateRange): {
    from: Date;
    to: Date;
  } {
    const to = params.to ? new Date(params.to) : new Date();
    const from = params.from
      ? new Date(params.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    return { from, to };
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
