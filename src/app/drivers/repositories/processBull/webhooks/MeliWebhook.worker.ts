import { Job, Worker } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';
import { ProcessMeliWebhookNotification } from 'src/core/interactors/ProcessMeliWebhookNotification';
import {
  MELI_WEBHOOK_QUEUE_NAME,
  MeliWebhookJobs,
  MeliWebhookPayload,
} from './MeliWebhook.queue';

export function startMeliWebhookWorker(
  interactor: ProcessMeliWebhookNotification,
) {
  const worker = new Worker<MeliWebhookPayload>(
    MELI_WEBHOOK_QUEUE_NAME,
    async (job: Job<MeliWebhookPayload>) => {
      if (job.name !== MeliWebhookJobs.PROCESS_NOTIFICATION) {
        console.log('Unknown Meli webhook job:', job.name);
        return;
      }

      await interactor.execute(job.data);
    },
    {
      connection: bullmqConnection,
      concurrency: Number(process.env.MELI_WEBHOOK_WORKER_CONCURRENCY ?? 5),
    },
  );

  worker.on('completed', (job) => {
    console.log(`Meli webhook job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Meli webhook job failed: ${job?.id}`, err);
  });

  worker.on('error', (err) => {
    console.error('Meli webhook worker error:', err);
  });

  return worker;
}
