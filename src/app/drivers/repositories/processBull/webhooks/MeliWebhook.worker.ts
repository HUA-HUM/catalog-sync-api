import { Job, Worker } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';
import { ProcessMeliWebhookNotification } from 'src/core/interactors/ProcessMeliWebhookNotification';
import {
  MELI_WEBHOOK_QUEUE_NAME,
  MeliWebhookJobs,
  MeliWebhookPayload,
} from './MeliWebhook.queue';
import { MeliWebhookLogger } from './MeliWebhook.logger';

export function startMeliWebhookWorker(
  interactor: ProcessMeliWebhookNotification,
) {
  const worker = new Worker<MeliWebhookPayload>(
    MELI_WEBHOOK_QUEUE_NAME,
    async (job: Job<MeliWebhookPayload>) => {
      if (job.name !== MeliWebhookJobs.PROCESS_NOTIFICATION) {
        MeliWebhookLogger.processing(`unknown job=${job.name}`);
        return;
      }

      MeliWebhookLogger.processing(
        `start job=${job.id} topic=${job.data.topic} resource=${job.data.resource}`,
      );
      await interactor.execute(job.data);
    },
    {
      connection: bullmqConnection,
      concurrency: Number(process.env.MELI_WEBHOOK_WORKER_CONCURRENCY ?? 5),
    },
  );

  worker.on('completed', (job) => {
    MeliWebhookLogger.processing(`completed job=${job.id}`);
  });

  worker.on('failed', (job, err) => {
    MeliWebhookLogger.error(`failed job=${job?.id}`, err);
  });

  worker.on('error', (err) => {
    MeliWebhookLogger.error('worker error', err);
  });

  return worker;
}
