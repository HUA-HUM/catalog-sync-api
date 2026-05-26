import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

import { ItemsIdQueue } from './drivers/repositories/processBull/itemsId/ItemsId.queue';
import { ItemsDetailsQueue } from './drivers/repositories/processBull/ItemsDetail/ItemsDetails.queue';
import { ItemsVisitsQueue } from './drivers/repositories/processBull/itemsVisits/ItemsVisits.queue';
import { MeliCategoriesQueue } from './drivers/repositories/processBull/categories/MeliCategories.queue';
import { UpdateItemsDetailsQueue } from './drivers/repositories/processBull/ItemsDetail/updated/UpdatedDetailsJob.queue';
import { MeliWebhookQueue } from './drivers/repositories/processBull/webhooks/MeliWebhook.queue';
import { CatalogBackfillQueue } from './drivers/repositories/processBull/catalogBackfill/CatalogBackfill.queue';

export function setupBullBoard(app: any) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [
      new BullMQAdapter(ItemsIdQueue),
      new BullMQAdapter(ItemsDetailsQueue),
      new BullMQAdapter(ItemsVisitsQueue),
      new BullMQAdapter(MeliCategoriesQueue),
      new BullMQAdapter(UpdateItemsDetailsQueue),
      new BullMQAdapter(MeliWebhookQueue),
      new BullMQAdapter(CatalogBackfillQueue),
    ],
    serverAdapter,
  });

  app.use('/admin/queues', serverAdapter.getRouter());
}
