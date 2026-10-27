import { Injectable } from '@nestjs/common';
import { QUEUE_RETENTION } from 'src/app/drivers/repositories/processBull/queue.retention';
import {
  ItemsIdJobs,
  ItemsIdQueue,
} from 'src/app/drivers/repositories/processBull/itemsId/ItemsId.queue';

@Injectable()
export class ItemsIdService {
  /**
   * Encola el proceso ItemsId
   * - No ejecuta lógica
   * - No bloquea
   * - Seguro para ejecutar a mano
   * - Con reintentos automáticos
   */
  async runSync(sellerId: string) {
    const job = await ItemsIdQueue.add(
      ItemsIdJobs.SYNC_ITEMS_ID,
      { sellerId },
      {
        jobId: `items-id-${sellerId}`,

        attempts: 5,

        backoff: {
          type: 'exponential',
          delay: 3000,
        },

        removeOnComplete: QUEUE_RETENTION.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.removeOnFail,
      },
    );

    return {
      status: 'queued',
      seller_id: sellerId,
      job_id: job.id,
      attempts: 5,
    };
  }
}
