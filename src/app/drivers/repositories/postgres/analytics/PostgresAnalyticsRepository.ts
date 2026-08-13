import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  AnalyticsDateRange,
  CategoryHistoryQuery,
  CategoryListQuery,
  CategoryPerformanceQuery,
  CategoryPublicationsQuery,
  CategoryRevenueQuery,
  CategoryVisitsQuery,
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

  async getCategories(params: CategoryListQuery): Promise<unknown> {
    const metadataConfig = await this.getCategoryMetadataConfig();

    if (metadataConfig) {
      return this.getCategoriesFromMetadata(params, metadataConfig);
    }

    return this.getCategoriesFromProductPerformance(params);
  }

  async getCategoryPublications(
    params: CategoryPublicationsQuery,
  ): Promise<unknown> {
    const values: unknown[] = [params.categoryId];
    const filters = ['category_id = $1'];

    if (params.domainId) {
      values.push(params.domainId);
      filters.push(`domain_id = $${values.length}`);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [summaryResult, byDomainResult] = await Promise.all([
      this.pool.query(
        `
        SELECT
          COUNT(*)::int AS total_publications,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_publications,
          COUNT(*) FILTER (WHERE status = 'paused')::int AS paused_publications,
          COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_publications,
          COUNT(*) FILTER (WHERE COALESCE(stock, 0) > 0)::int AS publications_with_stock,
          COUNT(*) FILTER (WHERE COALESCE(stock, 0) <= 0)::int AS publications_without_stock,
          COALESCE(SUM(stock), 0)::int AS total_stock,
          COALESCE(SUM(catalog_sold_quantity), 0)::int AS total_sold_quantity,
          ROUND(AVG(price), 2)::numeric AS avg_price,
          MIN(date_created) AS oldest_publication,
          MAX(date_created) AS newest_publication
        FROM analytics.product_performance
        ${whereSql}
        `,
        values,
      ),
      this.pool.query(
        `
        SELECT
          domain_id,
          COUNT(*)::int AS total_publications,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_publications,
          COUNT(*) FILTER (WHERE status = 'paused')::int AS paused_publications,
          COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_publications
        FROM analytics.product_performance
        ${whereSql}
        GROUP BY domain_id
        ORDER BY total_publications DESC, domain_id ASC
        `,
        values,
      ),
    ]);

    return {
      category_id: params.categoryId,
      domain_id: params.domainId ?? null,
      source: 'analytics.product_performance',
      publications: summaryResult.rows[0],
      by_domain: byDomainResult.rows,
    };
  }

  async getCategoryVisits(params: CategoryVisitsQuery): Promise<unknown> {
    const values: unknown[] = [params.categoryId];
    const filters = ['category_id = $1'];

    if (params.domainId) {
      values.push(params.domainId);
      filters.push(`domain_id = $${values.length}`);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [summaryResult, byDomainResult, topProductsResult] =
      await Promise.all([
        this.pool.query(
          `
          SELECT
            COALESCE(SUM(total_visits), 0)::int AS total_visits,
            COUNT(*)::int AS total_publications,
            COUNT(*) FILTER (
              WHERE COALESCE(total_visits, 0) > 0
            )::int AS publications_with_visits,
            COUNT(*) FILTER (
              WHERE COALESCE(total_visits, 0) = 0
            )::int AS publications_without_visits,
            ROUND(AVG(COALESCE(total_visits, 0)), 2)::numeric AS avg_visits_per_publication,
            COALESCE(MAX(total_visits), 0)::int AS max_visits,
            COALESCE(MIN(COALESCE(total_visits, 0)), 0)::int AS min_visits,
            MAX(last_updated) AS newest_product_update
          FROM analytics.product_performance
          ${whereSql}
          `,
          values,
        ),
        this.pool.query(
          `
          SELECT
            domain_id,
            COALESCE(SUM(total_visits), 0)::int AS total_visits,
            COUNT(*)::int AS total_publications,
            COUNT(*) FILTER (
              WHERE COALESCE(total_visits, 0) > 0
            )::int AS publications_with_visits
          FROM analytics.product_performance
          ${whereSql}
          GROUP BY domain_id
          ORDER BY total_visits DESC, domain_id ASC
          `,
          values,
        ),
        this.pool.query(
          `
          SELECT
            item_id,
            title,
            sku,
            brand,
            total_visits,
            status
          FROM analytics.product_performance
          ${whereSql}
          ORDER BY total_visits DESC NULLS LAST, item_id ASC
          LIMIT 10
          `,
          values,
        ),
      ]);

    return {
      category_id: params.categoryId,
      domain_id: params.domainId ?? null,
      source: 'analytics.product_performance',
      visits: summaryResult.rows[0],
      by_domain: byDomainResult.rows,
      top_products: topProductsResult.rows,
    };
  }

  async getCategoryRevenue(params: CategoryRevenueQuery): Promise<unknown> {
    const values: unknown[] = [params.categoryId];
    const filters = ['category_id = $1'];

    if (params.domainId) {
      values.push(params.domainId);
      filters.push(`domain_id = $${values.length}`);
    }

    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const [summaryResult, byDomainResult, topProductsResult] =
      await Promise.all([
        this.pool.query(
          `
          SELECT
            COALESCE(SUM(revenue), 0)::numeric AS total_revenue,
            COALESCE(SUM(units_sold), 0)::int AS units_sold,
            COALESCE(SUM(orders_count), 0)::int AS orders_count,
            COUNT(*)::int AS total_publications,
            COUNT(*) FILTER (
              WHERE COALESCE(revenue, 0) > 0
            )::int AS publications_with_revenue,
            COUNT(*) FILTER (
              WHERE COALESCE(revenue, 0) = 0
            )::int AS publications_without_revenue,
            ROUND(
              CASE
                WHEN COALESCE(SUM(orders_count), 0) = 0 THEN 0
                ELSE COALESCE(SUM(revenue), 0)::numeric / SUM(orders_count)
              END,
              2
            )::numeric AS avg_revenue_per_order,
            ROUND(
              CASE
                WHEN COALESCE(SUM(units_sold), 0) = 0 THEN 0
                ELSE COALESCE(SUM(revenue), 0)::numeric / SUM(units_sold)
              END,
              2
            )::numeric AS avg_revenue_per_unit,
            COALESCE(MAX(revenue), 0)::numeric AS max_product_revenue,
            MIN(first_order_date) AS first_order_date,
            MAX(last_order_date) AS last_order_date
          FROM analytics.product_performance
          ${whereSql}
          `,
          values,
        ),
        this.pool.query(
          `
          SELECT
            domain_id,
            COALESCE(SUM(revenue), 0)::numeric AS total_revenue,
            COALESCE(SUM(units_sold), 0)::int AS units_sold,
            COALESCE(SUM(orders_count), 0)::int AS orders_count,
            COUNT(*)::int AS total_publications,
            COUNT(*) FILTER (
              WHERE COALESCE(revenue, 0) > 0
            )::int AS publications_with_revenue
          FROM analytics.product_performance
          ${whereSql}
          GROUP BY domain_id
          ORDER BY total_revenue DESC, domain_id ASC
          `,
          values,
        ),
        this.pool.query(
          `
          SELECT
            item_id,
            title,
            sku,
            brand,
            revenue,
            orders_count,
            units_sold,
            status
          FROM analytics.product_performance
          ${whereSql}
          ORDER BY revenue DESC NULLS LAST, item_id ASC
          LIMIT 10
          `,
          values,
        ),
      ]);

    return {
      category_id: params.categoryId,
      domain_id: params.domainId ?? null,
      source: 'analytics.product_performance',
      revenue: summaryResult.rows[0],
      by_domain: byDomainResult.rows,
      top_products: topProductsResult.rows,
    };
  }

  async getCategoryPerformance(
    params: CategoryPerformanceQuery,
  ): Promise<unknown> {
    const range = this.buildDateRange(params);
    const [countResult, categoriesResult] = await Promise.all([
      this.pool.query(`
        SELECT COUNT(*)::int AS total
        FROM (
          SELECT 1
          FROM meli_items i
          WHERE i.category_id IS NOT NULL
          GROUP BY i.category_id, i.domain_id
        ) categories
      `),
      this.pool.query(
        `
      WITH category_catalog AS (
        SELECT
          i.category_id,
          i.domain_id,
          COUNT(*)::int AS products_count,
          COUNT(*) FILTER (WHERE i.status = 'active')::int AS published_products_count,
          COUNT(*) FILTER (WHERE i.status = 'paused')::int AS paused_products_count,
          COUNT(*) FILTER (WHERE i.status = 'closed')::int AS closed_products_count,
          COUNT(DISTINCT i.brand)::int AS brands_count,
          COALESCE(SUM(i.stock), 0)::int AS total_stock,
          COALESCE(SUM(i.sold_quantity), 0)::int AS catalog_sold_quantity,
          ROUND(AVG(i.price), 2)::numeric AS avg_price,
          MIN(i.date_created) AS oldest_publication,
          MAX(i.date_created) AS newest_publication
        FROM meli_items i
        WHERE i.category_id IS NOT NULL
        GROUP BY i.category_id, i.domain_id
      ),
      category_orders AS (
        SELECT
          i.category_id,
          i.domain_id,
          COUNT(DISTINCT o.order_id)::int AS orders_count,
          COUNT(DISTINCT oi.item_id)::int AS products_with_orders,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
        FROM meli_orders o
        JOIN meli_order_items oi
          ON oi.seller_id = o.seller_id
         AND oi.order_id = o.order_id
        JOIN meli_items i
          ON i.seller_id = oi.seller_id
         AND i.item_id = oi.item_id
        WHERE i.category_id IS NOT NULL
          AND o.date_closed >= $1
          AND o.date_closed < $2
        GROUP BY i.category_id, i.domain_id
      ),
      category_visits AS (
        SELECT
          i.category_id,
          i.domain_id,
          COUNT(v.item_id)::int AS products_with_visits,
          COALESCE(SUM(v.total_visits), 0)::int AS visits
        FROM meli_items i
        LEFT JOIN meli_item_visits_current v
          ON v.seller_id = i.seller_id
         AND v.item_id = i.item_id
        WHERE i.category_id IS NOT NULL
        GROUP BY i.category_id, i.domain_id
      )
      SELECT
        c.category_id,
        c.domain_id,
        c.products_count,
        c.published_products_count,
        c.paused_products_count,
        c.closed_products_count,
        c.brands_count,
        c.total_stock,
        c.catalog_sold_quantity,
        c.avg_price,
        c.oldest_publication,
        c.newest_publication,
        COALESCE(v.products_with_visits, 0)::int AS products_with_visits,
        COALESCE(v.visits, 0)::int AS visits,
        COALESCE(o.products_with_orders, 0)::int AS products_with_orders,
        COALESCE(o.orders_count, 0)::int AS orders_count,
        COALESCE(o.units_sold, 0)::int AS units_sold,
        COALESCE(o.revenue, 0)::numeric AS revenue,
        ROUND(
          CASE
            WHEN COALESCE(o.orders_count, 0) = 0 THEN 0
            ELSE COALESCE(o.revenue, 0)::numeric / o.orders_count
          END,
          2
        )::numeric AS avg_order_value,
        ROUND(
          CASE
            WHEN COALESCE(v.visits, 0) = 0 THEN 0
            ELSE (COALESCE(o.orders_count, 0)::numeric / v.visits) * 100
          END,
          4
        )::numeric AS order_conversion_rate
      FROM category_catalog c
      LEFT JOIN category_orders o
        ON o.category_id = c.category_id
       AND o.domain_id IS NOT DISTINCT FROM c.domain_id
      LEFT JOIN category_visits v
        ON v.category_id = c.category_id
       AND v.domain_id IS NOT DISTINCT FROM c.domain_id
      ORDER BY revenue DESC, products_count DESC, c.category_id ASC, c.domain_id ASC
      LIMIT $3
      OFFSET $4
      `,
        [range.from, range.to, params.limit, params.offset],
      ),
    ]);

    const total = Number(countResult.rows[0]?.total ?? 0);

    return {
      range,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        page: Math.floor(params.offset / params.limit) + 1,
        total_pages: Math.ceil(total / params.limit),
        has_next: params.offset + params.limit < total,
        has_previous: params.offset > 0,
      },
      categories: categoriesResult.rows,
    };
  }

  async getCategoryHistory(params: CategoryHistoryQuery): Promise<unknown> {
    if (!params.from && !params.to) {
      return this.getCategoryHistoryFast(params);
    }

    const range = this.buildDateRange(params);
    const bucketStep = this.getBucketStep(params.granularity);
    const pageLimit = params.limit + 1;
    const result = await this.pool.query(
      `
      WITH category_products AS (
        SELECT
          date_trunc($3::text, i.date_created) AS bucket_start,
          i.category_id,
          i.domain_id,
          COUNT(*)::int AS products_created_count,
          COUNT(*) FILTER (WHERE i.status = 'active')::int AS published_products_count,
          COUNT(*) FILTER (WHERE i.status = 'paused')::int AS paused_products_count,
          COUNT(*) FILTER (WHERE i.status = 'closed')::int AS closed_products_count
        FROM meli_items i
        WHERE i.category_id IS NOT NULL
          AND i.date_created >= $1
          AND i.date_created < $2
        GROUP BY 1, i.category_id, i.domain_id
      ),
      category_orders AS (
        SELECT
          date_trunc($3::text, o.date_closed) AS bucket_start,
          i.category_id,
          i.domain_id,
          COUNT(DISTINCT o.order_id)::int AS orders_count,
          COUNT(DISTINCT oi.item_id)::int AS products_with_orders,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
        FROM meli_orders o
        JOIN meli_order_items oi
          ON oi.seller_id = o.seller_id
         AND oi.order_id = o.order_id
        JOIN meli_items i
          ON i.seller_id = oi.seller_id
         AND i.item_id = oi.item_id
        WHERE i.category_id IS NOT NULL
          AND o.date_closed >= $1
          AND o.date_closed < $2
        GROUP BY 1, i.category_id, i.domain_id
      ),
      range_visit_totals AS (
        SELECT
          date_trunc($3::text, s.captured_at) AS bucket_start,
          s.seller_id,
          s.item_id,
          MAX(s.total_visits)::int AS total_visits
        FROM meli_item_visit_snapshots s
        WHERE s.captured_at >= $1
          AND s.captured_at < $2
        GROUP BY 1, s.seller_id, s.item_id
      ),
      range_visit_items AS (
        SELECT DISTINCT seller_id, item_id
        FROM range_visit_totals
      ),
      baseline_visit_totals AS (
        SELECT
          date_trunc($3::text, $1::timestamptz) - $4::interval AS bucket_start,
          baseline.seller_id,
          baseline.item_id,
          baseline.total_visits
        FROM range_visit_items item
        JOIN LATERAL (
          SELECT
            s.seller_id,
            s.item_id,
            s.total_visits
          FROM meli_item_visit_snapshots s
          WHERE s.seller_id = item.seller_id
            AND s.item_id = item.item_id
            AND s.captured_at < $1
          ORDER BY s.captured_at DESC
          LIMIT 1
        ) baseline ON true
      ),
      visit_totals AS (
        SELECT * FROM baseline_visit_totals
        UNION ALL
        SELECT * FROM range_visit_totals
      ),
      visit_deltas AS (
        SELECT
          v.bucket_start,
          v.seller_id,
          v.item_id,
          GREATEST(
            v.total_visits - COALESCE(
              LAG(v.total_visits) OVER (
                PARTITION BY v.seller_id, v.item_id
                ORDER BY v.bucket_start
              ),
              v.total_visits
            ),
            0
          )::int AS visits
        FROM visit_totals v
      ),
      category_visits AS (
        SELECT
          v.bucket_start,
          i.category_id,
          i.domain_id,
          COUNT(DISTINCT v.item_id) FILTER (WHERE v.visits > 0)::int AS products_with_visits,
          COALESCE(SUM(v.visits), 0)::int AS visits
        FROM visit_deltas v
        JOIN meli_items i
          ON i.seller_id = v.seller_id
         AND i.item_id = v.item_id
        WHERE i.category_id IS NOT NULL
          AND v.bucket_start >= date_trunc($3::text, $1::timestamptz)
          AND v.bucket_start < $2
        GROUP BY v.bucket_start, i.category_id, i.domain_id
        HAVING COALESCE(SUM(v.visits), 0) > 0
      ),
      history_keys AS (
        SELECT bucket_start, category_id, domain_id FROM category_products
        UNION
        SELECT bucket_start, category_id, domain_id FROM category_orders
        UNION
        SELECT bucket_start, category_id, domain_id FROM category_visits
      ),
      history_rows AS (
        SELECT
          k.bucket_start AS period_start,
          k.bucket_start + $4::interval AS period_end,
          k.category_id,
          k.domain_id,
          COALESCE(p.products_created_count, 0)::int AS products_count,
          COALESCE(p.products_created_count, 0)::int AS products_created_count,
          COALESCE(p.published_products_count, 0)::int AS published_products_count,
          COALESCE(p.paused_products_count, 0)::int AS paused_products_count,
          COALESCE(p.closed_products_count, 0)::int AS closed_products_count,
          COALESCE(v.products_with_visits, 0)::int AS products_with_visits,
          COALESCE(v.visits, 0)::int AS visits,
          COALESCE(o.products_with_orders, 0)::int AS products_with_orders,
          COALESCE(o.orders_count, 0)::int AS orders_count,
          COALESCE(o.units_sold, 0)::int AS units_sold,
          COALESCE(o.revenue, 0)::numeric AS revenue,
          ROUND(
            CASE
              WHEN COALESCE(o.orders_count, 0) = 0 THEN 0
              ELSE COALESCE(o.revenue, 0)::numeric / o.orders_count
            END,
            2
          )::numeric AS avg_order_value,
          ROUND(
            CASE
              WHEN COALESCE(v.visits, 0) = 0 THEN 0
              ELSE (COALESCE(o.orders_count, 0)::numeric / v.visits) * 100
            END,
            4
          )::numeric AS order_conversion_rate
        FROM history_keys k
        LEFT JOIN category_products p
          ON p.bucket_start = k.bucket_start
         AND p.category_id = k.category_id
         AND p.domain_id IS NOT DISTINCT FROM k.domain_id
        LEFT JOIN category_orders o
          ON o.bucket_start = k.bucket_start
         AND o.category_id = k.category_id
         AND o.domain_id IS NOT DISTINCT FROM k.domain_id
        LEFT JOIN category_visits v
          ON v.bucket_start = k.bucket_start
         AND v.category_id = k.category_id
         AND v.domain_id IS NOT DISTINCT FROM k.domain_id
      )
      SELECT
        *
      FROM history_rows
      ORDER BY
        period_start DESC,
        revenue DESC,
        products_count DESC,
        category_id ASC,
        domain_id ASC
      LIMIT $5
      OFFSET $6
      `,
      [
        range.from,
        range.to,
        params.granularity,
        bucketStep,
        pageLimit,
        params.offset,
      ],
    );

    const hasNext = result.rows.length > params.limit;
    const history = result.rows.slice(0, params.limit);

    return {
      range,
      granularity: params.granularity,
      pagination: {
        total: null,
        limit: params.limit,
        offset: params.offset,
        page: Math.floor(params.offset / params.limit) + 1,
        total_pages: null,
        has_next: hasNext,
        has_previous: params.offset > 0,
      },
      history,
    };
  }

  private async getCategoryHistoryFast(
    params: CategoryHistoryQuery,
  ): Promise<unknown> {
    const range = this.buildDefaultCategoryHistoryRange(params.granularity);
    const bucketStep = this.getBucketStep(params.granularity);
    const categoriesResult = await this.pool.query<{
      category_id: string;
      domain_id: string | null;
    }>(
      `
      SELECT category_id, domain_id
      FROM analytics.product_performance
      WHERE category_id IS NOT NULL
      GROUP BY category_id, domain_id
      ORDER BY category_id ASC, domain_id ASC
      LIMIT $1
      OFFSET $2
      `,
      [params.limit + 1, params.offset],
    );

    const hasNext = categoriesResult.rows.length > params.limit;
    const selectedCategories = categoriesResult.rows.slice(0, params.limit);

    if (!selectedCategories.length) {
      return {
        range,
        granularity: params.granularity,
        mode: 'fast_current_visits',
        pagination: {
          total: null,
          limit: params.limit,
          offset: params.offset,
          page: Math.floor(params.offset / params.limit) + 1,
          total_pages: null,
          has_next: false,
          has_previous: params.offset > 0,
          unit: 'categories',
        },
        history: [],
      };
    }

    const categoryIds = selectedCategories.map(
      (category) => category.category_id,
    );
    const domainIds = selectedCategories.map((category) => category.domain_id);

    const result = await this.pool.query(
      `
      WITH selected_categories AS (
        SELECT category_id, domain_id, ordinality
        FROM UNNEST($5::text[], $6::text[]) WITH ORDINALITY AS selected(
          category_id,
          domain_id,
          ordinality
        )
      ),
      category_products AS (
        SELECT
          date_trunc($3::text, i.date_created) AS bucket_start,
          i.category_id,
          i.domain_id,
          COUNT(*)::int AS products_created_count,
          COUNT(*) FILTER (WHERE i.status = 'active')::int AS published_products_count,
          COUNT(*) FILTER (WHERE i.status = 'paused')::int AS paused_products_count,
          COUNT(*) FILTER (WHERE i.status = 'closed')::int AS closed_products_count
        FROM analytics.product_performance i
        JOIN selected_categories selected
          ON selected.category_id = i.category_id
         AND selected.domain_id IS NOT DISTINCT FROM i.domain_id
        WHERE i.date_created >= $1
          AND i.date_created < $2
        GROUP BY 1, i.category_id, i.domain_id
      ),
      category_orders AS (
        SELECT
          date_trunc($3::text, o.date_closed) AS bucket_start,
          product_performance.category_id,
          product_performance.domain_id,
          COUNT(DISTINCT o.order_id)::int AS orders_count,
          COUNT(DISTINCT oi.item_id)::int AS products_with_orders,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
        FROM meli_orders o
        JOIN meli_order_items oi
          ON oi.seller_id = o.seller_id
         AND oi.order_id = o.order_id
        JOIN analytics.product_performance product_performance
          ON product_performance.seller_id = oi.seller_id
         AND product_performance.item_id = oi.item_id
        JOIN selected_categories selected
          ON selected.category_id = product_performance.category_id
         AND selected.domain_id IS NOT DISTINCT FROM product_performance.domain_id
        WHERE o.date_closed >= $1
          AND o.date_closed < $2
        GROUP BY 1, product_performance.category_id, product_performance.domain_id
      ),
      category_current_visits AS (
        SELECT
          product_performance.category_id,
          product_performance.domain_id,
          COUNT(*) FILTER (
            WHERE COALESCE(product_performance.total_visits, 0) > 0
          )::int AS products_with_visits,
          COALESCE(SUM(product_performance.total_visits), 0)::int AS visits
        FROM analytics.product_performance product_performance
        JOIN selected_categories selected
          ON selected.category_id = product_performance.category_id
         AND selected.domain_id IS NOT DISTINCT FROM product_performance.domain_id
        GROUP BY product_performance.category_id, product_performance.domain_id
      ),
      history_keys AS (
        SELECT bucket_start, category_id, domain_id FROM category_products
        UNION
        SELECT bucket_start, category_id, domain_id FROM category_orders
      ),
      history_rows AS (
        SELECT
          k.bucket_start AS period_start,
          k.bucket_start + $4::interval AS period_end,
          k.category_id,
          k.domain_id,
          COALESCE(p.products_created_count, 0)::int AS products_count,
          COALESCE(p.products_created_count, 0)::int AS products_created_count,
          COALESCE(p.published_products_count, 0)::int AS published_products_count,
          COALESCE(p.paused_products_count, 0)::int AS paused_products_count,
          COALESCE(p.closed_products_count, 0)::int AS closed_products_count,
          COALESCE(v.products_with_visits, 0)::int AS products_with_visits,
          COALESCE(v.visits, 0)::int AS visits,
          COALESCE(o.products_with_orders, 0)::int AS products_with_orders,
          COALESCE(o.orders_count, 0)::int AS orders_count,
          COALESCE(o.units_sold, 0)::int AS units_sold,
          COALESCE(o.revenue, 0)::numeric AS revenue,
          ROUND(
            CASE
              WHEN COALESCE(o.orders_count, 0) = 0 THEN 0
              ELSE COALESCE(o.revenue, 0)::numeric / o.orders_count
            END,
            2
          )::numeric AS avg_order_value,
          ROUND(
            CASE
              WHEN COALESCE(v.visits, 0) = 0 THEN 0
              ELSE (COALESCE(o.orders_count, 0)::numeric / v.visits) * 100
            END,
            4
          )::numeric AS order_conversion_rate,
          'current_snapshot' AS visits_mode
        FROM history_keys k
        LEFT JOIN category_products p
          ON p.bucket_start = k.bucket_start
         AND p.category_id = k.category_id
         AND p.domain_id IS NOT DISTINCT FROM k.domain_id
        LEFT JOIN category_orders o
          ON o.bucket_start = k.bucket_start
         AND o.category_id = k.category_id
         AND o.domain_id IS NOT DISTINCT FROM k.domain_id
        LEFT JOIN category_current_visits v
          ON v.category_id = k.category_id
         AND v.domain_id IS NOT DISTINCT FROM k.domain_id
      )
      SELECT
        *
      FROM history_rows
      ORDER BY
        period_start DESC,
        revenue DESC,
        products_count DESC,
        category_id ASC,
        domain_id ASC
      `,
      [
        range.from,
        range.to,
        params.granularity,
        bucketStep,
        categoryIds,
        domainIds,
      ],
    );

    return {
      range,
      granularity: params.granularity,
      mode: 'fast_current_visits',
      pagination: {
        total: null,
        limit: params.limit,
        offset: params.offset,
        page: Math.floor(params.offset / params.limit) + 1,
        total_pages: null,
        has_next: hasNext,
        has_previous: params.offset > 0,
        unit: 'categories',
      },
      categories: selectedCategories,
      history: result.rows,
    };
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

  private getBucketStep(granularity: CategoryHistoryQuery['granularity']) {
    const steps: Record<CategoryHistoryQuery['granularity'], string> = {
      day: '1 day',
      week: '1 week',
      month: '1 month',
    };

    return steps[granularity];
  }

  private buildDefaultCategoryHistoryRange(
    granularity: CategoryHistoryQuery['granularity'],
  ): {
    from: Date;
    to: Date;
  } {
    const to = new Date();
    const from = new Date(to);

    if (granularity === 'day') {
      from.setDate(from.getDate() - 30);
    } else if (granularity === 'week') {
      from.setDate(from.getDate() - 26 * 7);
    } else {
      from.setMonth(from.getMonth() - 12);
    }

    return { from, to };
  }

  private async getCategoryMetadataConfig(): Promise<{
    idColumn: string;
    pathColumn: string;
    nameColumn?: string;
    parentIdColumn?: string;
    levelColumn?: string;
  } | null> {
    try {
      const result = await this.pool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'meli_categories'
      `);

      const columns = new Set(result.rows.map((row) => row.column_name));
      const idColumn = columns.has('id')
        ? 'id'
        : columns.has('category_id')
          ? 'category_id'
          : null;
      const pathColumn = columns.has('path') ? 'path' : null;

      if (!idColumn || !pathColumn) {
        return null;
      }

      return {
        idColumn,
        pathColumn,
        nameColumn: columns.has('name') ? 'name' : undefined,
        parentIdColumn: columns.has('parent_id')
          ? 'parent_id'
          : columns.has('parentId')
            ? 'parentId'
            : undefined,
        levelColumn: columns.has('level') ? 'level' : undefined,
      };
    } catch {
      return null;
    }
  }

  private async getCategoriesFromMetadata(
    params: CategoryListQuery,
    metadataConfig: {
      idColumn: string;
      pathColumn: string;
      nameColumn?: string;
      parentIdColumn?: string;
      levelColumn?: string;
    },
  ): Promise<unknown> {
    const idColumn = this.quoteIdentifier(metadataConfig.idColumn);
    const pathColumn = this.quoteIdentifier(metadataConfig.pathColumn);
    const nameColumn = metadataConfig.nameColumn
      ? this.quoteIdentifier(metadataConfig.nameColumn)
      : null;
    const parentIdColumn = metadataConfig.parentIdColumn
      ? this.quoteIdentifier(metadataConfig.parentIdColumn)
      : null;
    const levelColumn = metadataConfig.levelColumn
      ? this.quoteIdentifier(metadataConfig.levelColumn)
      : null;

    const values: unknown[] = [params.limit + 1, params.offset];
    const filters: string[] = [];

    if (params.search) {
      values.push(`%${params.search}%`);
      const searchParam = `$${values.length}`;
      const searchFilters = [
        `c.${idColumn}::text ILIKE ${searchParam}`,
        `c.${pathColumn}::text ILIKE ${searchParam}`,
      ];

      if (nameColumn) {
        searchFilters.push(`c.${nameColumn}::text ILIKE ${searchParam}`);
      }

      filters.push(`(${searchFilters.join(' OR ')})`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const nameSql = nameColumn ? `c.${nameColumn}::text` : 'NULL::text';
    const parentIdSql = parentIdColumn
      ? `c.${parentIdColumn}::text`
      : 'NULL::text';
    const levelSql = levelColumn ? `c.${levelColumn}::int` : 'NULL::int';

    const result = await this.pool.query(
      `
      WITH listed AS (
        SELECT
          c.${idColumn}::text AS category_id,
          ${nameSql} AS name,
          ${parentIdSql} AS parent_id,
          ${levelSql} AS level,
          c.${pathColumn}::text AS path
        FROM public.meli_categories c
        ${whereSql}
        ORDER BY c.${pathColumn}::text ASC, c.${idColumn}::text ASC
        LIMIT $1
        OFFSET $2
      ),
      product_counts AS (
        SELECT
          category_id,
          COUNT(*)::int AS products_count
        FROM analytics.product_performance
        WHERE category_id IN (SELECT category_id FROM listed)
        GROUP BY category_id
      )
      SELECT
        listed.category_id,
        NULL::text AS domain_id,
        listed.name,
        listed.parent_id,
        listed.level,
        listed.path,
        TRUE AS has_path_metadata,
        COALESCE(product_counts.products_count, 0)::int AS products_count
      FROM listed
      LEFT JOIN product_counts
        ON product_counts.category_id = listed.category_id
      ORDER BY listed.path ASC, listed.category_id ASC
      `,
      values,
    );

    return this.buildCategoryListResponse({
      rows: result.rows,
      params,
      source: 'public.meli_categories',
      hasPathMetadata: true,
    });
  }

  private async getCategoriesFromProductPerformance(
    params: CategoryListQuery,
  ): Promise<unknown> {
    const values: unknown[] = [params.limit + 1, params.offset];
    const filters = ['category_id IS NOT NULL'];

    if (params.search) {
      values.push(`%${params.search}%`);
      const searchParam = `$${values.length}`;
      filters.push(
        `(category_id ILIKE ${searchParam} OR COALESCE(domain_id, '') ILIKE ${searchParam})`,
      );
    }

    const result = await this.pool.query(
      `
      SELECT
        category_id,
        domain_id,
        NULL::text AS name,
        NULL::text AS parent_id,
        NULL::int AS level,
        category_id AS path,
        FALSE AS has_path_metadata,
        COUNT(*)::int AS products_count
      FROM analytics.product_performance
      WHERE ${filters.join(' AND ')}
      GROUP BY category_id, domain_id
      ORDER BY category_id ASC, domain_id ASC
      LIMIT $1
      OFFSET $2
      `,
      values,
    );

    return this.buildCategoryListResponse({
      rows: result.rows,
      params,
      source: 'analytics.product_performance',
      hasPathMetadata: false,
    });
  }

  private buildCategoryListResponse(params: {
    rows: unknown[];
    params: CategoryListQuery;
    source: string;
    hasPathMetadata: boolean;
  }): unknown {
    const hasNext = params.rows.length > params.params.limit;
    const categories = params.rows.slice(0, params.params.limit);

    return {
      source: params.source,
      has_path_metadata: params.hasPathMetadata,
      pagination: {
        total: null,
        limit: params.params.limit,
        offset: params.params.offset,
        page: Math.floor(params.params.offset / params.params.limit) + 1,
        total_pages: null,
        has_next: hasNext,
        has_previous: params.params.offset > 0,
      },
      categories,
    };
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
