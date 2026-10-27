import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MeliWebhookJobs,
  MeliWebhookPayload,
  MeliWebhookQueue,
} from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.queue';
import { MeliWebhookLogger } from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.logger';

import { QUEUE_RETENTION } from 'src/app/drivers/repositories/processBull/queue.retention';
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

    MeliWebhookLogger.received(
      `topic=${payload.topic} resource=${payload.resource} user=${payload.user_id ?? 'unknown'}`,
    );

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
        removeOnFail: QUEUE_RETENTION.removeOnFail,
      },
    );

    return {
      status: 'queued',
      job_id: job.id,
    };
  }

  /**
   * El id lleva sufijo unico a proposito.
   *
   * Con un id deterministico, BullMQ descarta en silencio cualquier `add` cuyo
   * id ya exista. Un job que agoto sus 8 intentos queda en `failed` y bloquea
   * para siempre toda notificacion futura de ese mismo item: el ítem deja de
   * actualizarse y no hay ningun error que lo delate.
   *
   * Se pierde la deduplicacion entre notificaciones repetidas, pero el
   * interactor agrupa y deduplica los MLAs de cada lote antes de pegarle a
   * Meli, asi que el costo real es practicamente nulo.
   */
  private buildJobId(topic: string, resource: string): string {
    const base = `meli-webhook-${topic}-${resource.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

    return `${base}-${Date.now()}-${(this.sequence = (this.sequence + 1) % 1_000_000)}`;
  }

  private sequence = 0;

  private getRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private getOptionalStringOrNumber(
    value: unknown,
  ): string | number | undefined {
    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }

    return undefined;
  }
}
