import { Injectable, BadRequestException } from '@nestjs/common';
import { QUEUE_RETENTION } from 'src/app/drivers/repositories/processBull/queue.retention';
import {
  ItemsDetailsJobs,
  ItemsDetailsQueue,
} from 'src/app/drivers/repositories/processBull/ItemsDetail/ItemsDetails.queue';

@Injectable()
export class ItemsDetailsService {
  async runSync(sellerId: string) {
    if (!sellerId) {
      throw new BadRequestException('sellerId is required');
    }

    const job = await ItemsDetailsQueue.add(
      ItemsDetailsJobs.SYNC_ITEMS_DETAILS,
      { sellerId },
      {
        jobId: `items-details-${sellerId}`,
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
