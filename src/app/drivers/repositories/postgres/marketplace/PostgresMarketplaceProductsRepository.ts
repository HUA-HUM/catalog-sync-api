import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  IMarketplaceProductsRepository,
  MarketplaceProductChanges,
  MarketplaceProductInput,
  MarketplaceProductRow,
  MarketplaceProductsFilters,
  MarketplaceProductsPage,
  MarketplaceProductsStatusCount,
} from 'src/core/adapters/postgres/marketplace/IMarketplaceProductsRepository';

@Injectable()
export class PostgresMarketplaceProductsRepository implements IMarketplaceProductsRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * last_seen_at se mueve en cada corrida; updated_at, solo si cambio algo.
   * Los items no pueden repetir external_id: Postgres no deja que un mismo
   * INSERT toque dos veces la misma fila.
   */
  async bulkUpsert(
    marketplace: string,
    items: MarketplaceProductInput[],
  ): Promise<void> {
    if (!items.length) return;

    await this.pool.query(
      `
      INSERT INTO marketplace_products AS existing (
        id,
        marketplace,
        external_id,
        seller_sku,
        marketplace_sku,
        price,
        stock,
        status,
        raw_payload
      )
      SELECT
        rows.id,
        $1::text,
        rows.external_id,
        rows.seller_sku,
        rows.marketplace_sku,
        rows.price,
        rows.stock,
        rows.status,
        rows.raw_payload::jsonb
      FROM UNNEST(
        $2::uuid[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::numeric[],
        $7::integer[],
        $8::text[],
        $9::text[]
      ) AS rows(
        id,
        external_id,
        seller_sku,
        marketplace_sku,
        price,
        stock,
        status,
        raw_payload
      )
      ON CONFLICT (marketplace, external_id) DO UPDATE SET
        seller_sku = EXCLUDED.seller_sku,
        marketplace_sku = EXCLUDED.marketplace_sku,
        price = EXCLUDED.price,
        stock = EXCLUDED.stock,
        status = EXCLUDED.status,
        raw_payload = EXCLUDED.raw_payload,
        last_seen_at = now(),
        updated_at = CASE
          WHEN (
            existing.seller_sku,
            existing.marketplace_sku,
            existing.price,
            existing.stock,
            existing.status,
            existing.raw_payload
          ) IS DISTINCT FROM (
            EXCLUDED.seller_sku,
            EXCLUDED.marketplace_sku,
            EXCLUDED.price,
            EXCLUDED.stock,
            EXCLUDED.status,
            EXCLUDED.raw_payload
          )
          THEN now()
          ELSE existing.updated_at
        END
      `,
      [
        marketplace,
        items.map(() => randomUUID()),
        items.map((item) => item.externalId),
        items.map((item) => item.sellerSku),
        items.map((item) => item.marketplaceSku),
        items.map((item) => item.price),
        items.map((item) => item.stock),
        items.map((item) => item.status),
        items.map((item) => JSON.stringify(item.raw)),
      ],
    );
  }

  async create(
    marketplace: string,
    item: MarketplaceProductInput,
  ): Promise<MarketplaceProductRow> {
    const { rows } = await this.pool.query<MarketplaceProductRow>(
      `
      INSERT INTO marketplace_products (
        id,
        marketplace,
        external_id,
        seller_sku,
        marketplace_sku,
        price,
        stock,
        status,
        raw_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
      `,
      [
        randomUUID(),
        marketplace,
        item.externalId,
        item.sellerSku,
        item.marketplaceSku,
        item.price,
        item.stock,
        item.status,
        JSON.stringify(item.raw),
      ],
    );

    return rows[0];
  }

  async findById(id: string): Promise<MarketplaceProductRow | null> {
    const { rows } = await this.pool.query<MarketplaceProductRow>(
      'SELECT * FROM marketplace_products WHERE id = $1',
      [id],
    );

    return rows[0] ?? null;
  }

  async update(
    id: string,
    changes: MarketplaceProductChanges,
  ): Promise<MarketplaceProductRow | null> {
    const { rows } = await this.pool.query<MarketplaceProductRow>(
      `
      UPDATE marketplace_products
      SET
        seller_sku = COALESCE($2::text, seller_sku),
        marketplace_sku = COALESCE($3::text, marketplace_sku),
        price = COALESCE($4::numeric, price),
        stock = COALESCE($5::integer, stock),
        status = COALESCE($6::text, status),
        raw_payload = COALESCE($7::jsonb, raw_payload),
        updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        changes.sellerSku ?? null,
        changes.marketplaceSku ?? null,
        changes.price ?? null,
        changes.stock ?? null,
        changes.status ?? null,
        changes.raw ? JSON.stringify(changes.raw) : null,
      ],
    );

    return rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM marketplace_products WHERE id = $1',
      [id],
    );

    return Boolean(rowCount);
  }

  async existsBySellerSku(
    marketplace: string,
    sellerSku: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `
      SELECT 1
      FROM marketplace_products
      WHERE marketplace = $1
        AND seller_sku = $2
      LIMIT 1
      `,
      [marketplace, sellerSku],
    );

    return Boolean(rowCount);
  }

  async list(
    filters: MarketplaceProductsFilters,
    page: MarketplaceProductsPage,
  ): Promise<MarketplaceProductRow[]> {
    const { where, values } = this.buildWhere(filters);
    const limitParam = values.length + 1;
    const offsetParam = values.length + 2;

    const { rows } = await this.pool.query<MarketplaceProductRow>(
      `
      SELECT *
      FROM marketplace_products
      WHERE ${where}
      ORDER BY seller_sku, id
      LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      [...values, page.limit, page.offset],
    );

    return rows;
  }

  async countByStatus(
    filters: MarketplaceProductsFilters,
  ): Promise<MarketplaceProductsStatusCount[]> {
    const { where, values } = this.buildWhere(filters);

    const { rows } = await this.pool.query<{ status: string; total: string }>(
      `
      SELECT status, COUNT(*) AS total
      FROM marketplace_products
      WHERE ${where}
      GROUP BY status
      ORDER BY COUNT(*) DESC, status ASC
      `,
      values,
    );

    return rows.map((row) => ({
      status: row.status,
      total: Number(row.total),
    }));
  }

  private buildWhere(filters: MarketplaceProductsFilters): {
    where: string;
    values: string[];
  } {
    const conditions = ['marketplace = $1'];
    const values = [filters.marketplace];

    if (filters.sku) {
      values.push(`%${filters.sku.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`seller_sku ILIKE $${values.length}`);
    }

    if (filters.status) {
      values.push(filters.status);
      conditions.push(`LOWER(status) = LOWER($${values.length})`);
    }

    return { where: conditions.join(' AND '), values };
  }
}
