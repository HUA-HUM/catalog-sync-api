import { Inject, Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  CatalogBackfillDetailsPayload,
  CatalogBackfillJobs,
  CatalogBackfillOrdersPayload,
  CatalogBackfillPayload,
  CatalogBackfillQueue,
  CatalogBackfillScanPayload,
  CatalogBackfillVisitsRefreshPayload,
  CatalogBackfillVisitsPayload,
  CatalogBackfillVisitsChunkPayload,
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

import { QUEUE_RETENTION } from 'src/app/drivers/repositories/processBull/queue.retention';
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
  /** Publicaciones por job. Ver CatalogBackfillVisitsChunkPayload. */
  private static readonly VISITS_CHUNK_SIZE = Number(
    process.env.VISITS_REFRESH_CHUNK_SIZE ?? 50,
  );

  /**
   * Llamadas a Meli en vuelo dentro de un mismo lote. Multiplica por la
   * concurrencia del worker: 5 x 5 = 25 en vuelo. Con ~1s por llamada eso son
   * ~2,1M visitas por dia, suficiente para las 1.248.321 publicaciones activas.
   */
  private static readonly VISITS_CHUNK_PARALLELISM = Number(
    process.env.VISITS_CHUNK_PARALLELISM ?? 5,
  );

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
      case CatalogBackfillJobs.SYNC_VISITS_CHUNK:
        await this.syncVisitsChunk(
          job as Job<CatalogBackfillVisitsChunkPayload>,
        );
        return;
      case CatalogBackfillJobs.ENQUEUE_VISITS_REFRESH:
        await this.enqueueVisitsRefresh(
          job as Job<CatalogBackfillVisitsRefreshPayload>,
        );
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
            scroll_id: scrollId || undefined,
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
            removeOnFail: QUEUE_RETENTION.removeOnFail,
          },
        );
      }

      processed += pageItems.length;
      page++;
      scrollId = response.scroll_id;
      const total = response.pagination?.total;
      const reachedRequestedLimit =
        Boolean(payload.maxItems && processed >= payload.maxItems) ||
        Boolean(payload.maxPages && page >= payload.maxPages);

      await job.updateProgress({
        pages: page,
        processed,
        total,
      });

      if (
        !reachedRequestedLimit &&
        total &&
        processed < total &&
        (!scrollId || response.pagination?.has_next === false)
      ) {
        throw new Error(
          `Scan stopped early: processed=${processed} total=${total} hasNext=${response.pagination?.has_next} scrollId=${scrollId ?? 'missing'}`,
        );
      }

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

    const products: MeliBulkProduct[] = [];
    const bulkChunks = this.chunk(payload.itemIds, 20);

    for (const bulkChunk of bulkChunks) {
      const chunkProducts = await this.getFromMeliWithRetry<MeliBulkProduct[]>(
        '/meli/products/bulk',
        {
          params: {
            ids: bulkChunk.join(','),
          },
        },
      );

      if (bulkChunk.length > 0 && chunkProducts.length === 0) {
        throw new Error(
          `Bulk details returned 0 products for ${bulkChunk.length} requested ids. first=${bulkChunk[0]}`,
        );
      }

      products.push(...chunkProducts);
    }

    if (payload.itemIds.length > 0 && products.length === 0) {
      throw new Error(
        `Bulk details returned 0 products for ${payload.itemIds.length} requested ids. first=${payload.itemIds[0]}`,
      );
    }

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
            removeOnFail: QUEUE_RETENTION.removeOnFail,
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
            removeOnFail: QUEUE_RETENTION.removeOnFail,
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
      const response =
        await this.getFromMeliWithRetry<MeliProductOrdersResponse>(
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

  private async enqueueVisitsRefresh(
    job: Job<CatalogBackfillVisitsRefreshPayload>,
  ): Promise<void> {
    const payload = job.data;
    const items = await this.catalogRepository.findItemsForVisitsRefresh({
      staleAfterDays: payload.staleAfterDays,
      limit: payload.limit,
      statuses: payload.statuses,
    });

    await this.logJob(
      job,
      `[visits-refresh] staleAfterDays=${payload.staleAfterDays} statuses=${payload.statuses?.join('|') ?? 'all'} selected=${items.length} limit=${payload.limit ?? 'none'}`,
    );

    const chunks = this.chunk(items, ProcessCatalogBackfill.VISITS_CHUNK_SIZE);

    for (const [index, chunkItems] of chunks.entries()) {
      await CatalogBackfillQueue.add(
        CatalogBackfillJobs.SYNC_VISITS_CHUNK,
        {
          runId: payload.runId,
          items: chunkItems,
        },
        {
          jobId: `${payload.runId}-visits-chunk-${index}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: QUEUE_RETENTION.removeOnFail,
        },
      );
    }

    await this.logJob(
      job,
      `[visits-refresh] items=${items.length} chunks=${chunks.length} chunkSize=${ProcessCatalogBackfill.VISITS_CHUNK_SIZE}`,
    );
  }

  /**
   * Resuelve las visitas de un lote de publicaciones.
   *
   * Una publicacion que falla no arrastra al lote entero: se cuenta y se sigue.
   * Esto es a proposito. Si se rechazara el job por un solo item, los 50 se
   * reintentarian juntos y el lote volveria a formarse igual, girando en vacio
   * sin avanzar nunca; es el mismo error que tuvimos en la cola de webhooks.
   * Como no se actualiza su captured_at, el item fallido vuelve a entrar en la
   * seleccion de la pasada siguiente por si solo.
   *
   * Solo si fallan todas se rechaza el job, porque eso ya no es una publicacion
   * rota sino el proxy caido, y ahi el reintento con backoff sirve.
   */
  private async syncVisitsChunk(
    job: Job<CatalogBackfillVisitsChunkPayload>,
  ): Promise<void> {
    const payload = job.data;
    const items = payload.items ?? [];

    if (!items.length) return;

    await this.logJob(job, `[visits-chunk] start items=${items.length}`);

    let ok = 0;
    const failures: string[] = [];
    let lastError: unknown = null;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const item = items[cursor++];

        try {
          const visit = await this.getFromMeliWithRetry<{
            item_id: string;
            total: number;
          }>(`/meli/items/${item.itemId}/visits`);

          await this.visitsRepository.upsertCurrentAndSnapshot({
            sellerId: item.sellerId,
            visit,
          });

          ok++;
        } catch (error) {
          lastError = error;
          failures.push(item.itemId);
        }
      }
    };

    const lanes = Math.min(
      ProcessCatalogBackfill.VISITS_CHUNK_PARALLELISM,
      items.length,
    );

    await Promise.all(Array.from({ length: lanes }, () => worker()));

    await this.logJob(
      job,
      `[visits-chunk] done ok=${ok} failed=${failures.length}` +
        (failures.length ? ` first=${failures[0]}` : '') +
        (lastError
          ? ` lastError=${lastError instanceof Error ? lastError.message : String(lastError)}`
          : ''),
    );

    if (!ok && failures.length) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`visits chunk failed for all ${failures.length} items`);
    }

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

        // El motivo va en el log a proposito: sin el, un 500 del proxy y un
        // timeout se ven igual, y eso fue lo que hizo falta para diagnosticar
        // por que la pasada de visitas rinde seis veces menos de lo esperado.
        console.warn(
          `[ProcessCatalogBackfill] Meli request failed | url=${url} | attempt=${attempt}/${maxAttempts} | retry_in_ms=${delayMs} | reason=${
            error instanceof Error ? error.message : String(error)
          }`,
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
