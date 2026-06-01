import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import {
  IUpsertMeliCatalogRepository,
  MeliCatalogSyncAudit,
  MeliBulkProduct,
  MeliBulkProductAttribute,
  MeliBulkProductVariation,
} from 'src/core/adapters/postgres/catalog/IUpsertMeliCatalogRepository';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';

@Injectable()
export class PostgresMeliCatalogRepository
  implements IUpsertMeliCatalogRepository
{
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async upsertPendingItems(params: {
    sellerId: number | string;
    itemIds: string[];
  }): Promise<void> {
    if (!params.itemIds.length) return;

    const sellerId = Number(params.sellerId);
    const values = params.itemIds.map((itemId) => [sellerId, itemId]);

    await this.pool.query(
      `
      INSERT INTO meli_items (seller_id, item_id, sync_status)
      SELECT seller_id, item_id, 'pending_detail'
      FROM UNNEST($1::bigint[], $2::text[]) AS rows(seller_id, item_id)
      ON CONFLICT (seller_id, item_id) DO NOTHING
      `,
      [values.map(([value]) => value), values.map(([, value]) => value)],
    );
  }

  async findItemsMissingDetails(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  > {
    const result = await this.pool.query<{
      seller_id: number;
      item_id: string;
    }>(
      `
      SELECT i.seller_id, i.item_id
      FROM meli_items i
      LEFT JOIN meli_item_details d
        ON d.seller_id = i.seller_id
       AND d.item_id = i.item_id
      WHERE d.item_id IS NULL
      ORDER BY i.created_at ASC, i.item_id ASC
      ${limit ? 'LIMIT $1' : ''}
      `,
      limit ? [limit] : [],
    );

    return result.rows.map((row) => ({
      sellerId: Number(row.seller_id),
      itemId: row.item_id,
    }));
  }

  async findItemsForOrders(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  > {
    const result = await this.pool.query<{
      seller_id: number;
      item_id: string;
    }>(
      `
      SELECT i.seller_id, i.item_id
      FROM meli_items i
      WHERE i.sync_status = 'synced'
        AND COALESCE(i.sold_quantity, 0) > 0
      ORDER BY i.last_synced_at ASC NULLS FIRST, i.item_id ASC
      ${limit ? 'LIMIT $1' : ''}
      `,
      limit ? [limit] : [],
    );

    return result.rows.map((row) => ({
      sellerId: Number(row.seller_id),
      itemId: row.item_id,
    }));
  }

  async findItemsForVisits(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  > {
    const result = await this.pool.query<{
      seller_id: number;
      item_id: string;
    }>(
      `
      SELECT i.seller_id, i.item_id
      FROM meli_items i
      LEFT JOIN meli_item_visits_current v
        ON v.seller_id = i.seller_id
       AND v.item_id = i.item_id
      WHERE i.sync_status = 'synced'
        AND v.item_id IS NULL
      ORDER BY i.last_synced_at ASC NULLS FIRST, i.item_id ASC
      ${limit ? 'LIMIT $1' : ''}
      `,
      limit ? [limit] : [],
    );

    return result.rows.map((row) => ({
      sellerId: Number(row.seller_id),
      itemId: row.item_id,
    }));
  }

  async findItemsForVisitsRefresh(params: {
    staleAfterDays: number;
    limit?: number;
  }): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  > {
    const values: unknown[] = [params.staleAfterDays];
    const limitSql = params.limit ? 'LIMIT $2' : '';

    if (params.limit) {
      values.push(params.limit);
    }

    const result = await this.pool.query<{
      seller_id: number;
      item_id: string;
    }>(
      `
      SELECT i.seller_id, i.item_id
      FROM meli_items i
      LEFT JOIN meli_item_visits_current v
        ON v.seller_id = i.seller_id
       AND v.item_id = i.item_id
      WHERE i.sync_status = 'synced'
        AND (
          v.item_id IS NULL
          OR v.captured_at <= now() - ($1::int * interval '1 day')
        )
      ORDER BY v.captured_at ASC NULLS FIRST, i.item_id ASC
      ${limitSql}
      `,
      values,
    );

    return result.rows.map((row) => ({
      sellerId: Number(row.seller_id),
      itemId: row.item_id,
    }));
  }

  async getDailySyncAudit(params: {
    date?: string;
    timezone: string;
    recentLimit: number;
  }): Promise<MeliCatalogSyncAudit> {
    const bounds = await this.pool.query<{
      audit_date: string;
      start_at: Date;
      end_at: Date;
    }>(
      `
      WITH input AS (
        SELECT
          COALESCE($1::date, (now() AT TIME ZONE $2)::date) AS audit_date,
          $2::text AS timezone
      )
      SELECT
        audit_date::text,
        audit_date::timestamp AT TIME ZONE timezone AS start_at,
        (audit_date + 1)::timestamp AT TIME ZONE timezone AS end_at
      FROM input
      `,
      [params.date ?? null, params.timezone],
    );

    const bound = bounds.rows[0];
    const counts = await this.pool.query<{
      items_synced: string;
      item_rows_updated: string;
      details_synced: string;
      orders_updated: string;
      visits_captured: string;
      visit_snapshots: string;
    }>(
      `
      SELECT
        (SELECT COUNT(*) FROM meli_items WHERE last_synced_at >= $1 AND last_synced_at < $2) AS items_synced,
        (SELECT COUNT(*) FROM meli_items WHERE updated_at >= $1 AND updated_at < $2) AS item_rows_updated,
        (SELECT COUNT(*) FROM meli_item_details WHERE synced_at >= $1 AND synced_at < $2) AS details_synced,
        (SELECT COUNT(*) FROM meli_orders WHERE updated_at >= $1 AND updated_at < $2) AS orders_updated,
        (SELECT COUNT(*) FROM meli_item_visits_current WHERE captured_at >= $1 AND captured_at < $2) AS visits_captured,
        (SELECT COUNT(*) FROM meli_item_visit_snapshots WHERE captured_at >= $1 AND captured_at < $2) AS visit_snapshots
      `,
      [bound.start_at, bound.end_at],
    );

    const recentItems = await this.pool.query<{
      item_id: string;
      title: string | null;
      price: string | null;
      stock: number | null;
      sold_quantity: number | null;
      status: string | null;
      last_updated: Date | null;
      last_synced_at: Date | null;
      updated_at: Date | null;
    }>(
      `
      SELECT
        item_id,
        title,
        price,
        stock,
        sold_quantity,
        status,
        last_updated,
        last_synced_at,
        updated_at
      FROM meli_items
      WHERE last_synced_at >= $1
        AND last_synced_at < $2
      ORDER BY last_synced_at DESC
      LIMIT $3
      `,
      [bound.start_at, bound.end_at, params.recentLimit],
    );

    const countRow = counts.rows[0];

    return {
      date: bound.audit_date,
      timezone: params.timezone,
      startAt: bound.start_at,
      endAt: bound.end_at,
      counts: {
        itemsSynced: Number(countRow.items_synced),
        itemRowsUpdated: Number(countRow.item_rows_updated),
        detailsSynced: Number(countRow.details_synced),
        ordersUpdated: Number(countRow.orders_updated),
        visitsCaptured: Number(countRow.visits_captured),
        visitSnapshots: Number(countRow.visit_snapshots),
      },
      recentItems: recentItems.rows.map((row) => ({
        itemId: row.item_id,
        title: row.title,
        price: row.price === null ? null : Number(row.price),
        stock: row.stock,
        soldQuantity: row.sold_quantity,
        status: row.status,
        lastUpdated: row.last_updated,
        lastSyncedAt: row.last_synced_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  async upsertProducts(products: MeliBulkProduct[]): Promise<void> {
    if (!products.length) return;

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const product of products) {
        await this.upsertProduct(client, product);
        await this.replaceAttributes(client, product);
        await this.replacePictures(client, product);
        await this.replaceVariations(client, product);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertProduct(
    client: PoolClient,
    product: MeliBulkProduct,
  ): Promise<void> {
    const sellerId = this.getSellerId(product);
    const itemId = product.id;

    await client.query(
      `
      INSERT INTO meli_items (
        seller_id,
        item_id,
        site_id,
        category_id,
        domain_id,
        title,
        status,
        condition,
        buying_mode,
        listing_type_id,
        price,
        base_price,
        original_price,
        currency_id,
        stock,
        initial_quantity,
        available_quantity,
        sold_quantity,
        seller_sku,
        seller_custom_field,
        brand,
        permalink,
        thumbnail_id,
        thumbnail,
        health,
        warranty,
        free_shipping,
        catalog_product_id,
        catalog_listing,
        user_product_id,
        family_name,
        family_id,
        official_store_id,
        inventory_id,
        parent_item_id,
        automatic_relist,
        accepts_mercadopago,
        international_delivery_mode,
        date_created,
        last_updated,
        start_time,
        stop_time,
        end_time,
        expiration_time,
        sync_status,
        last_synced_at,
        raw
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
        $41, $42, $43, $44, 'synced', now(), $45
      )
      ON CONFLICT (seller_id, item_id) DO UPDATE SET
        site_id = EXCLUDED.site_id,
        category_id = EXCLUDED.category_id,
        domain_id = EXCLUDED.domain_id,
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        condition = EXCLUDED.condition,
        buying_mode = EXCLUDED.buying_mode,
        listing_type_id = EXCLUDED.listing_type_id,
        price = EXCLUDED.price,
        base_price = EXCLUDED.base_price,
        original_price = EXCLUDED.original_price,
        currency_id = EXCLUDED.currency_id,
        stock = EXCLUDED.stock,
        initial_quantity = EXCLUDED.initial_quantity,
        available_quantity = EXCLUDED.available_quantity,
        sold_quantity = EXCLUDED.sold_quantity,
        seller_sku = EXCLUDED.seller_sku,
        seller_custom_field = EXCLUDED.seller_custom_field,
        brand = EXCLUDED.brand,
        permalink = EXCLUDED.permalink,
        thumbnail_id = EXCLUDED.thumbnail_id,
        thumbnail = EXCLUDED.thumbnail,
        health = EXCLUDED.health,
        warranty = EXCLUDED.warranty,
        free_shipping = EXCLUDED.free_shipping,
        catalog_product_id = EXCLUDED.catalog_product_id,
        catalog_listing = EXCLUDED.catalog_listing,
        user_product_id = EXCLUDED.user_product_id,
        family_name = EXCLUDED.family_name,
        family_id = EXCLUDED.family_id,
        official_store_id = EXCLUDED.official_store_id,
        inventory_id = EXCLUDED.inventory_id,
        parent_item_id = EXCLUDED.parent_item_id,
        automatic_relist = EXCLUDED.automatic_relist,
        accepts_mercadopago = EXCLUDED.accepts_mercadopago,
        international_delivery_mode = EXCLUDED.international_delivery_mode,
        date_created = EXCLUDED.date_created,
        last_updated = EXCLUDED.last_updated,
        start_time = EXCLUDED.start_time,
        stop_time = EXCLUDED.stop_time,
        end_time = EXCLUDED.end_time,
        expiration_time = EXCLUDED.expiration_time,
        sync_status = EXCLUDED.sync_status,
        last_synced_at = EXCLUDED.last_synced_at,
        raw = EXCLUDED.raw
      `,
      [
        sellerId,
        itemId,
        product.site_id ?? null,
        product.categoryId ?? null,
        product.domain_id ?? null,
        product.title ?? null,
        product.status ?? null,
        product.condition ?? null,
        product.buyingMode ?? null,
        product.listingTypeId ?? null,
        product.price ?? null,
        product.base_price ?? null,
        product.original_price ?? null,
        product.currency ?? null,
        product.stock ?? null,
        product.initial_quantity ?? null,
        product.available_quantity ?? null,
        product.soldQuantity ?? null,
        product.sellerSku ?? null,
        product.seller_custom_field ?? null,
        product.brand ?? null,
        product.permalink ?? null,
        product.thumbnailId ?? null,
        product.thumbnail ?? null,
        product.health ?? null,
        product.warranty ?? null,
        product.freeShipping ?? null,
        product.catalog_product_id ?? null,
        product.catalog_listing ?? null,
        product.user_product_id ?? null,
        product.family_name ?? null,
        product.family_id ?? null,
        product.official_store_id ?? null,
        product.inventory_id ?? null,
        product.parent_item_id ?? null,
        product.automatic_relist ?? null,
        product.accepts_mercadopago ?? null,
        product.international_delivery_mode ?? null,
        product.date_created ?? null,
        product.last_updated ?? product.lastUpdated ?? null,
        product.start_time ?? null,
        product.stop_time ?? null,
        product.end_time ?? null,
        product.expiration_time ?? null,
        JSON.stringify(product),
      ],
    );

    await client.query(
      `
      INSERT INTO meli_item_details (
        seller_id,
        item_id,
        description,
        sale_terms,
        shipping,
        attributes,
        variations,
        pictures,
        sub_status,
        tags,
        channels,
        warnings,
        item_relations,
        deal_ids,
        raw,
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, now()
      )
      ON CONFLICT (seller_id, item_id) DO UPDATE SET
        description = EXCLUDED.description,
        sale_terms = EXCLUDED.sale_terms,
        shipping = EXCLUDED.shipping,
        attributes = EXCLUDED.attributes,
        variations = EXCLUDED.variations,
        pictures = EXCLUDED.pictures,
        sub_status = EXCLUDED.sub_status,
        tags = EXCLUDED.tags,
        channels = EXCLUDED.channels,
        warnings = EXCLUDED.warnings,
        item_relations = EXCLUDED.item_relations,
        deal_ids = EXCLUDED.deal_ids,
        raw = EXCLUDED.raw,
        synced_at = EXCLUDED.synced_at,
        updated_at = now()
      `,
      [
        sellerId,
        itemId,
        product.description ?? null,
        this.toJson(product.sale_terms),
        this.toJson(product.shipping),
        this.toJson(product.attributes),
        this.toJson(product.variations),
        this.toJson(product.pictures),
        this.toJson(product.sub_status),
        this.toJson(product.tags),
        this.toJson(product.channels),
        this.toJson(product.warnings),
        this.toJson(product.item_relations),
        this.toJson(product.deal_ids),
        JSON.stringify(product),
      ],
    );
  }

  private async replaceAttributes(
    client: PoolClient,
    product: MeliBulkProduct,
  ): Promise<void> {
    const sellerId = this.getSellerId(product);
    const attributes = product.attributes ?? [];

    await client.query(
      'DELETE FROM meli_item_attributes WHERE seller_id = $1 AND item_id = $2',
      [sellerId, product.id],
    );

    for (const attribute of attributes) {
      await this.insertAttribute(client, sellerId, product.id, attribute);
    }
  }

  private async insertAttribute(
    client: PoolClient,
    sellerId: number,
    itemId: string,
    attribute: MeliBulkProductAttribute,
  ): Promise<void> {
    if (!attribute.id) return;

    await client.query(
      `
      INSERT INTO meli_item_attributes (
        seller_id,
        item_id,
        attribute_id,
        name,
        value_id,
        value_name,
        value_type,
        values_json,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        sellerId,
        itemId,
        attribute.id,
        attribute.name ?? null,
        attribute.value_id ?? null,
        attribute.value_name ?? null,
        attribute.value_type ?? null,
        this.toJson(attribute.values),
        JSON.stringify(attribute),
      ],
    );
  }

  private async replacePictures(
    client: PoolClient,
    product: MeliBulkProduct,
  ): Promise<void> {
    const sellerId = this.getSellerId(product);
    const pictures = product.pictures ?? [];

    await client.query(
      'DELETE FROM meli_item_pictures WHERE seller_id = $1 AND item_id = $2',
      [sellerId, product.id],
    );

    for (const [index, url] of pictures.entries()) {
      await client.query(
        `
        INSERT INTO meli_item_pictures (seller_id, item_id, position, url)
        VALUES ($1, $2, $3, $4)
        `,
        [sellerId, product.id, index, url],
      );
    }
  }

  private async replaceVariations(
    client: PoolClient,
    product: MeliBulkProduct,
  ): Promise<void> {
    const sellerId = this.getSellerId(product);
    const variations = product.variations ?? [];

    await client.query(
      'DELETE FROM meli_item_variations WHERE seller_id = $1 AND item_id = $2',
      [sellerId, product.id],
    );

    for (const variation of variations) {
      await this.insertVariation(client, sellerId, product.id, variation);
    }
  }

  private async insertVariation(
    client: PoolClient,
    sellerId: number,
    itemId: string,
    variation: MeliBulkProductVariation,
  ): Promise<void> {
    const variationId = variation.id ?? variation.variation_id;
    if (!variationId) return;

    await client.query(
      `
      INSERT INTO meli_item_variations (
        seller_id,
        item_id,
        variation_id,
        seller_sku,
        price,
        available_quantity,
        sold_quantity,
        attributes,
        attribute_combinations,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        sellerId,
        itemId,
        String(variationId),
        variation.sellerSku ?? variation.seller_sku ?? null,
        variation.price ?? null,
        variation.available_quantity ?? null,
        variation.sold_quantity ?? null,
        this.toJson(variation.attributes),
        this.toJson(variation.attribute_combinations),
        JSON.stringify(variation),
      ],
    );
  }

  private getSellerId(product: MeliBulkProduct): number {
    const sellerId = Number(product.seller_id);

    if (!sellerId) {
      throw new Error(`seller_id is required for product ${product.id}`);
    }

    return sellerId;
  }

  private toJson(value: unknown): string {
    return JSON.stringify(value ?? null);
  }
}
