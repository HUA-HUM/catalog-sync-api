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

    await this.logJob(
      job,
      `[scan] start run=${payload.runId} limit=${payload.limit} detailChunkSize=${payload.detailChunkSize} includeOrders=${payload.includeOrders} includeVisits=${payload.includeVisits}`,
    );

    while (true) {
      if (payload.maxPages && page >= payload.maxPages) break;
      if (payload.maxItems && processed >= payload.maxItems) break;

      await this.logJob(
        job,
        `[scan] fetching page=${page + 1} scrollId=${scrollId ?? 'initial'}`,
      );

      const response = await this.getFromMeliWithRetry<ScanProductsResponse>(
        '/mercadolibre/products',
        {
          params: {
            useScan: true,
            limit: payload.limit,
            offset: scrollId ? undefined : 0,
            scrollId: scrollId || undefined,
          },
        },
      );

      sellerId = response.seller_id;
      const items = response.items ?? [];
      if (!items.length) {
        await this.logJob(job, `[scan] no more items page=${page + 1}`);
        break;
      }

      const remaining = payload.maxItems
        ? Math.max(payload.maxItems - processed, 0)
        : items.length;
      const pageItems = items.slice(0, remaining);

      await this.catalogRepository.upsertPendingItems({
        sellerId,
        itemIds: pageItems,
      });

      const chunks = this.chunk(pageItems, payload.detailChunkSize);

      await this.logJob(
        job,
        `[scan] page=${page + 1} seller=${sellerId} received=${items.length} savedPending=${pageItems.length} chunks=${chunks.length} totalProcessed=${processed + pageItems.length} total=${response.pagination?.total ?? 'unknown'}`,
      );

      for (const chunk of chunks) {
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

    await this.logJob(
      job,
      `[scan] done run=${payload.runId} pages=${page} processed=${processed}`,
    );
  }

  private async syncDetailsChunk(
    job: Job<CatalogBackfillDetailsPayload>,
  ): Promise<void> {
    const payload = job.data;

    await this.logJob(
      job,
      `[details] start run=${payload.runId} items=${payload.itemIds.length} first=${payload.itemIds[0]}`,
    );

    const products = await this.getFromMeliWithRetry<MeliBulkProduct[]>(
      '/meli/products/bulk',
      {
        params: {
          ids: payload.itemIds.join(','),
        },
      },
    );

    await this.catalogRepository.upsertProducts(products);

    await this.logJob(
      job,
      `[details] saved products=${products.length} requested=${payload.itemIds.length}`,
    );

    let ordersJobs = 0;
    let visitsJobs = 0;

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
        ordersJobs++;
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
        visitsJobs++;
      }
    }

    await this.logJob(
      job,
      `[details] done products=${products.length} queuedOrders=${ordersJobs} queuedVisits=${visitsJobs}`,
    );

    await job.updateProgress(100);
  }

  private async syncOrdersForItem(
    job: Job<CatalogBackfillOrdersPayload>,
  ): Promise<void> {
    const payload = job.data;
    let offset = 0;
    let total = 0;
    let saved = 0;

    await this.logJob(
      job,
      `[orders] start item=${payload.itemId} status=${payload.status}`,
    );

    while (true) {
      const response = await this.getFromMeliWithRetry<MeliProductOrdersResponse>(
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

      saved += orders.length;
      total = response.paging?.total ?? total;
      offset += response.paging?.limit ?? payload.limit;
      await job.updateProgress({ offset, total });

      await this.logJob(
        job,
        `[orders] item=${payload.itemId} savedPage=${orders.length} savedTotal=${saved} offset=${offset} total=${total}`,
      );

      if (!response.paging?.total || offset >= response.paging.total) break;
    }

    await this.logJob(
      job,
      `[orders] done item=${payload.itemId} saved=${saved} total=${total}`,
    );
  }

  private async syncVisitsForItem(
    job: Job<CatalogBackfillVisitsPayload>,
  ): Promise<void> {
    const payload = job.data;

    await this.logJob(job, `[visits] start item=${payload.itemId}`);

    const visit = await this.getFromMeliWithRetry<{
      item_id: string;
      total: number;
    }>(`/meli/items/${payload.itemId}/visits`);

    await this.visitsRepository.upsertCurrentAndSnapshot({
      sellerId: payload.sellerId,
      visit,
    });

    await this.logJob(
      job,
      `[visits] done item=${payload.itemId} total=${visit.total}`,
    );

    await job.updateProgress(100);
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  private async getFromMeliWithRetry<T>(
    url: string,
    config?: Parameters<IMeliHttpClient['get']>[1],
  ): Promise<T> {
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.meliHttpClient.get<T>(url, config);
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }

        const delayMs = attempt >= 3 ? 20000 : 5000;

        console.warn(
          `[ProcessCatalogBackfill] Meli request failed | url=${url} | attempt=${attempt}/${maxAttempts} | retry_in_ms=${delayMs}`,
        );

        await this.sleep(delayMs);
      }
    }

    throw new Error(`Meli request failed without explicit error: ${url}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async logJob(
    job: Job<CatalogBackfillPayload>,
    message: string,
  ): Promise<void> {
    const logMessage = `[CatalogBackfill] ${message}`;
    console.log(logMessage);
    await job.log(logMessage);
  }
}
