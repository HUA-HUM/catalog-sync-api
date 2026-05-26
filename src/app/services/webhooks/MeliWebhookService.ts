import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MeliWebhookJobs,
  MeliWebhookPayload,
  MeliWebhookQueue,
} from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.queue';

@Injectable()
export class MeliWebhookService {
  async enqueueNotification(body: Record<string, unknown>) {
    const topic = this.getRequiredString(body.topic, 'topic');
    const resource = this.getRequiredString(body.resource, 'resource');

    const payload: MeliWebhookPayload = {
      topic,
      resource,
      user_id: this.getOptionalStringOrNumber(body.user_id),
      application_id: this.getOptionalStringOrNumber(body.application_id),
      receivedAt: new Date().toISOString(),
      raw: body,
    };

    const job = await MeliWebhookQueue.add(
      MeliWebhookJobs.PROCESS_NOTIFICATION,
      payload,
      {
        jobId: this.buildJobId(topic, resource),
        attempts: 8,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return {
      status: 'queued',
      job_id: job.id,
    };
  }

  private buildJobId(topic: string, resource: string): string {
    return `meli-webhook-${topic}-${resource.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  private getRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private getOptionalStringOrNumber(value: unknown): string | number | undefined {
    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }

    return undefined;
  }
}
