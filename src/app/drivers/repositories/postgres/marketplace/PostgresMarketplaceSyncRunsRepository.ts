import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  IMarketplaceSyncRunsRepository,
  MarketplaceSyncRunProgress,
  MarketplaceSyncRunRow,
} from 'src/core/adapters/postgres/marketplace/IMarketplaceSyncRunsRepository';

const ABANDONED_RUN_MESSAGE = 'Abandoned: a newer run started';

@Injectable()
export class PostgresMarketplaceSyncRunsRepository implements IMarketplaceSyncRunsRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * products-api corre un import por vez por canal: si queda uno en RUNNING al
   * abrir otro, es de un proceso que murio y nadie lo va a cerrar.
   */
  async start(marketplace: string): Promise<{ id: string; startedAt: Date }> {
    const id = randomUUID();

    const { rows } = await this.pool.query<{ started_at: Date }>(
      `
      WITH abandoned AS (
        UPDATE marketplace_sync_runs
        SET
          status = 'FAILED',
          error_message = $3,
          finished_at = now()
        WHERE marketplace = $2
          AND status = 'RUNNING'
      )
      INSERT INTO marketplace_sync_runs (id, marketplace, status)
      VALUES ($1, $2, 'RUNNING')
      RETURNING started_at
      `,
      [id, marketplace, ABANDONED_RUN_MESSAGE],
    );

    return { id, startedAt: rows[0].started_at };
  }

  async increment(
    id: string,
    progress: MarketplaceSyncRunProgress,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `
      UPDATE marketplace_sync_runs
      SET
        batches_processed = batches_processed + $2,
        items_processed = items_processed + $3,
        items_failed = items_failed + $4
      WHERE id = $1
      `,
      [id, progress.batches, progress.items, progress.failed],
    );

    return Boolean(rowCount);
  }

  async finish(id: string, status: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `
      UPDATE marketplace_sync_runs
      SET status = $2, finished_at = now()
      WHERE id = $1
      `,
      [id, status],
    );

    return Boolean(rowCount);
  }

  async fail(id: string, errorMessage: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `
      UPDATE marketplace_sync_runs
      SET status = 'FAILED', error_message = $2, finished_at = now()
      WHERE id = $1
      `,
      [id, errorMessage],
    );

    return Boolean(rowCount);
  }

  async list(
    marketplace: string,
    page: { limit: number; offset: number },
  ): Promise<MarketplaceSyncRunRow[]> {
    const { rows } = await this.pool.query<MarketplaceSyncRunRow>(
      `
      SELECT *
      FROM marketplace_sync_runs
      WHERE marketplace = $1
      ORDER BY started_at DESC
      LIMIT $2 OFFSET $3
      `,
      [marketplace, page.limit, page.offset],
    );

    return rows;
  }
}
