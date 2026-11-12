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
      // 5 jobs de lote en paralelo x VISITS_CHUNK_PARALLELISM llamadas cada
      // uno = 25 pedidos a Meli en vuelo. Con 5 y un job por publicacion el
      // ritmo real era ~5/s, insuficiente para pasar las activas en un dia.
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
