import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export const POSTGRES_POOL = 'POSTGRES_POOL';

function createPostgresPool(): Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.POSTGRES_SSL === 'true'
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  return new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'catalog_sync',
    user: process.env.POSTGRES_USER ?? 'catalog_sync',
    password: process.env.POSTGRES_PASSWORD ?? 'catalog_sync',
    ssl:
      process.env.POSTGRES_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
    max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      useFactory: createPostgresPool,
    },
  ],
  exports: [POSTGRES_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onModuleDestroy() {
    await this.pool.end();
  }
}
