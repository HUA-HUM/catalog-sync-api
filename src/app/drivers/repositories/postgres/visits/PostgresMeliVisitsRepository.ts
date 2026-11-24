import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  IUpsertMeliVisitsRepository,
  MeliItemVisitsResponse,
} from 'src/core/adapters/postgres/visits/IUpsertMeliVisitsRepository';

@Injectable()
export class PostgresMeliVisitsRepository implements IUpsertMeliVisitsRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * Version por lotes, para la pasada de visitas.
   *
   * Con el endpoint bulk del proxy un job trae 500 publicaciones de una. Hacer
   * dos queries por publicacion serian 1.000 viajes a Postgres por job; asi
   * son dos. Se usa unnest y no VALUES armado a mano para que siga siendo una
   * sentencia con parametros, sin interpolar nada en el SQL.
   *
   * Los parametros van casteados explicitamente a proposito: un parametro sin
   * tipo adentro de la query es lo que rompio upsertProduct en octubre.
   */
  async upsertManyCurrentAndSnapshot(params: {
    sellerId: number | string;
    visits: MeliItemVisitsResponse[];
    capturedAt?: Date;
  }): Promise<void> {
    const visits = params.visits ?? [];
    if (!visits.length) return;

    const sellerId = Number(params.sellerId);
    const capturedAt = params.capturedAt ?? new Date();
    const itemIds = visits.map((visit) => visit.item_id);
    const totals = visits.map((visit) => Number(visit.total ?? 0));

    await this.pool.query(
      `
      INSERT INTO meli_item_visits_current (
        seller_id,
        item_id,
        total_visits,
        captured_at
      )
      SELECT $1::bigint, t.item_id, t.total_visits, $4::timestamptz
      FROM unnest($2::text[], $3::int[]) AS t(item_id, total_visits)
      ON CONFLICT (seller_id, item_id) DO UPDATE SET
        total_visits = EXCLUDED.total_visits,
        captured_at = EXCLUDED.captured_at
      `,
      [sellerId, itemIds, totals, capturedAt],
    );

    await this.pool.query(
      `
      INSERT INTO meli_item_visit_snapshots (
        seller_id,
        item_id,
        total_visits,
        captured_at
      )
      SELECT $1::bigint, t.item_id, t.total_visits, $4::timestamptz
      FROM unnest($2::text[], $3::int[]) AS t(item_id, total_visits)
      `,
      [sellerId, itemIds, totals, capturedAt],
    );
  }

  async upsertCurrentAndSnapshot(params: {
    sellerId: number | string;
    visit: MeliItemVisitsResponse;
    capturedAt?: Date;
  }): Promise<void> {
    const sellerId = Number(params.sellerId);
    const capturedAt = params.capturedAt ?? new Date();

    await this.pool.query(
      `
      INSERT INTO meli_item_visits_current (
        seller_id,
        item_id,
        total_visits,
        captured_at
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (seller_id, item_id) DO UPDATE SET
        total_visits = EXCLUDED.total_visits,
        captured_at = EXCLUDED.captured_at
      `,
      [sellerId, params.visit.item_id, params.visit.total, capturedAt],
    );

    await this.pool.query(
      `
      INSERT INTO meli_item_visit_snapshots (
        seller_id,
        item_id,
        total_visits,
        captured_at
      )
      VALUES ($1, $2, $3, $4)
      `,
      [sellerId, params.visit.item_id, params.visit.total, capturedAt],
    );
  }
}
