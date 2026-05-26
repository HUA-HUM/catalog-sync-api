import { Job, Worker } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';
import {
  CATALOG_BACKFILL_QUEUE_NAME,
  CatalogBackfillPayload,
} from './CatalogBackfill.queue';
import { ProcessCatalogBackfill } from 'src/core/interactors/ProcessCatalogBackfill';

export function startCatalogBackfillWorker(interactor: ProcessCatalogBackfill) {
  const worker = new Worker<CatalogBackfillPayload>(
    CATALOG_BACKFILL_QUEUE_NAME,
    async (job: Job<CatalogBackfillPayload>) => {
      await interactor.execute(job);
    },
    {
      connection: bullmqConnection,
      concurrency: Number(process.env.CATALOG_BACKFILL_CONCURRENCY ?? 5),
    },
  );

  worker.on('completed', (job) => {
    console.log(`Catalog backfill job completed: ${job.name} ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Catalog backfill job failed: ${job?.name} ${job?.id}`, err);
  });

  worker.on('error', (err) => {
    console.error('Catalog backfill worker error:', err);
  });

  return worker;
}
