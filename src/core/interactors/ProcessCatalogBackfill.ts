import { Inject, Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CatalogBackfillDetailsPayload,
  CatalogBackfillJobs,
  CatalogBackfillOrdersPayload,
  CatalogBackfillPayload,
  CatalogBackfillQueue,
  CatalogBackfillScanPayload,
  CatalogBackfillVisitsPayload,
} from 'src/app/drivers/repositories/processBull/catalogBackfill/CatalogBackfill.queue';
import type { IMeliHttpClient } from 'src/core/adapters/mercadolibre-api/http/IMeliHttpClient';
import type {
  IUpsertMeliCatalogRepository,
  MeliBulkProduct,
} from 'src/core/adapters/postgres/catalog/IUpsertMeliCatalogRepository';
import type {
  IUpsertMeliOrdersRepository,
  MeliProductOrdersResponse,
} from 'src/core/adapters/postgres/orders/IUpsertMeliOrdersRepository';
import type { IUpsertMeliVisitsRepository } from 'src/core/adapters/postgres/visits/IUpsertMeliVisitsRepository';

type ScanProductsResponse = {
  seller_id: string | number;
  items: string[];
  scroll_id?: string;
  pagination?: {
    total?: number;
    has_next?: boolean;
  };
};

@Injectable()
export class ProcessCatalogBackfill {
  constructor(
    @Inject('IMeliHttpClient')
    private readonly meliHttpClient: IMeliHttpClient,

    @Inject('IUpsertMeliCatalogRepository')
    private readonly catalogRepository: IUpsertMeliCatalogRepository,

    @Inject('IUpsertMeliOrdersRepository')
    private readonly ordersRepository: IUpsertMeliOrdersRepository,

    @Inject('IUpsertMeliVisitsRepository')
    private readonly visitsRepository: IUpsertMeliVisitsRepository,
  ) {}

  async execute(job: Job<CatalogBackfillPayload>): Promise<void> {
    switch (job.name) {
      case CatalogBackfillJobs.SCAN_ITEMS:
        await this.scanItems(job as Job<CatalogBackfillScanPayload>);
        return;
      case CatalogBackfillJobs.SYNC_DETAILS_CHUNK:
        await this.syncDetailsChunk(job as Job<CatalogBackfillDetailsPayload>);
        return;
      case CatalogBackfillJobs.SYNC_ORDERS_FOR_ITEM:
        await this.syncOrdersForItem(job as Job<CatalogBackfillOrdersPayload>);
        return;
      case CatalogBackfillJobs.SYNC_VISITS_FOR_ITEM:
        await this.syncVisitsForItem(job as Job<CatalogBackfillVisitsPayload>);
        return;
      default:
        console.log(`[ProcessCatalogBackfill] Unknown job ${job.name}`);
    }
  }

  private async scanItems(job: Job<CatalogBackfillScanPayload>): Promise<void> {
    const payload = job.data;
    let scrollId: string | undefined;
    let sellerId: string | number | undefined;
    let page = 0;
    let processed = 0;

    while (true) {
      if (payload.maxPages && page >= payload.maxPages) break;
      if (payload.maxItems && processed >= payload.maxItems) break;

      const response = await this.meliHttpClient.get<ScanProductsResponse>(
        '/mercadolibre/products',
        {
          params: {
            useScan: true,
            limit: payload.limit,
            scrollId,
          },
        },
      );

      sellerId = response.seller_id;
      const items = response.items ?? [];
      if (!items.length) break;

      const remaining = payload.maxItems
        ? Math.max(payload.maxItems - processed, 0)
        : items.length;
      const pageItems = items.slice(0, remaining);

      await this.catalogRepository.upsertPendingItems({
        sellerId,
        itemIds: pageItems,
      });

      for (const chunk of this.chunk(pageItems, payload.detailChunkSize)) {
        await CatalogBackfillQueue.add(
          CatalogBackfillJobs.SYNC_DETAILS_CHUNK,
          {
            runId: payload.runId,
            sellerId,
            itemIds: chunk,
            includeOrders: payload.includeOrders,
            includeVisits: payload.includeVisits,
          },
          {
            jobId: `${payload.runId}-details-${chunk[0]}-${chunk.length}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      }

      processed += pageItems.length;
      page++;
      scrollId = response.scroll_id;

      await job.updateProgress({
        pages: page,
        processed,
        total: response.pagination?.total,
      });

      if (!scrollId || response.pagination?.has_next === false) break;
      if (payload.maxItems && processed >= payload.maxItems) break;
    }
  }

  private async syncDetailsChunk(
    job: Job<CatalogBackfillDetailsPayload>,
  ): Promise<void> {
    const payload = job.data;

    const products = await this.meliHttpClient.get<MeliBulkProduct[]>(
      '/meli/products/bulk',
      {
        params: {
          ids: payload.itemIds.join(','),
        },
      },
    );

    await this.catalogRepository.upsertProducts(products);

    for (const product of products) {
      if (payload.includeOrders && Number(product.soldQuantity ?? 0) > 0) {
        await CatalogBackfillQueue.add(
          CatalogBackfillJobs.SYNC_ORDERS_FOR_ITEM,
          {
            runId: payload.runId,
            sellerId: payload.sellerId,
            itemId: product.id,
            status: 'paid',
            limit: 50,
          },
          {
            jobId: `${payload.runId}-orders-${product.id}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      }

      if (payload.includeVisits) {
        await CatalogBackfillQueue.add(
          CatalogBackfillJobs.SYNC_VISITS_FOR_ITEM,
          {
            runId: payload.runId,
            sellerId: payload.sellerId,
            itemId: product.id,
          },
          {
            jobId: `${payload.runId}-visits-${product.id}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      }
    }

    await job.updateProgress(100);
  }

  private async syncOrdersForItem(
    job: Job<CatalogBackfillOrdersPayload>,
  ): Promise<void> {
    const payload = job.data;
    let offset = 0;
    let total = 0;

    while (true) {
      const response = await this.meliHttpClient.get<MeliProductOrdersResponse>(
        `/meli/products/${payload.itemId}/orders`,
        {
          params: {
            offset,
            limit: payload.limit,
            status: payload.status,
          },
        },
      );

      const orders = response.results ?? [];
      if (!orders.length) break;

      await this.ordersRepository.upsertOrders({
        sellerId: payload.sellerId,
        orders,
      });

      total = response.paging?.total ?? total;
      offset += response.paging?.limit ?? payload.limit;
      await job.updateProgress({ offset, total });

      if (!response.paging?.total || offset >= response.paging.total) break;
    }
  }

  private async syncVisitsForItem(
    job: Job<CatalogBackfillVisitsPayload>,
  ): Promise<void> {
    const payload = job.data;

    const visit = await this.meliHttpClient.get<{
      item_id: string;
      total: number;
    }>(`/meli/items/${payload.itemId}/visits`);

    await this.visitsRepository.upsertCurrentAndSnapshot({
      sellerId: payload.sellerId,
      visit,
    });

    await job.updateProgress(100);
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }
}
