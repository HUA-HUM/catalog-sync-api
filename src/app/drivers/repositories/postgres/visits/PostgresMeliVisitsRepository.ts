import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  IUpsertMeliVisitsRepository,
  MeliItemVisitsResponse,
} from 'src/core/adapters/postgres/visits/IUpsertMeliVisitsRepository';

@Injectable()
export class PostgresMeliVisitsRepository
  implements IUpsertMeliVisitsRepository
{
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

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
