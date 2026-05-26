import { Queue } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';

export const MELI_WEBHOOK_QUEUE_NAME = 'meli-webhooks';

export enum MeliWebhookJobs {
  PROCESS_NOTIFICATION = 'process-meli-notification',
}

export type MeliWebhookPayload = {
  topic: string;
  resource: string;
  user_id?: string | number;
  application_id?: string | number;
  receivedAt: string;
  raw: Record<string, unknown>;
};

export const MeliWebhookQueue = new Queue<MeliWebhookPayload>(
  MELI_WEBHOOK_QUEUE_NAME,
  {
    connection: bullmqConnection,
  },
);
