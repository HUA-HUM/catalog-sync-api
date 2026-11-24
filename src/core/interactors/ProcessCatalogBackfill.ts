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
import { MeliApiError } from 'src/core/drivers/mercadolibre-api/http/error/MeliApiError';

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
  /**
   * Publicaciones por job. El proxy acepta hasta 500 ids por pedido y los
   * resuelve contra Meli de a 50, asi que un job = un pedido HTTP.
   * Cubrir las 1.248.321 activas pasa de 1.248.321 llamadas a ~2.500.
   */
  private static readonly VISITS_CHUNK_SIZE = Number(
    process.env.VISITS_REFRESH_CHUNK_SIZE ?? 500,
  );

  /**
   * Proporcion de ceros a partir de la cual el lote se considera no confiable.
   *
   * El bulk del proxy devuelve `total: 0` tanto para "no tiene visitas" como
   * para "Meli no me contesto", sin distinguirlos. El 24/11, con Meli
   * limitando, lotes enteros volvieron 99,8% en cero y se escribieron como si
   * fueran valores reales: 57.584 publicaciones perdieron su valor antes de
   * que lo detectaramos.
   *
   * Un lote sano ronda el 50% de ceros, que es la proporcion real del catalogo
   * (615.348 publicaciones cerradas mas una cola larga de activas sin
   * trafico). Por encima de este umbral el lote se descarta entero y el job
   * falla para que BullMQ lo reintente; no se escribe nada.
   *
   * Es una guarda, no la solucion: la solucion es que el proxy distinga los
   * dos casos. Mientras no lo haga, esto es lo mejor que podemos afirmar desde
   * aca sin poder leer la intencion de un 0.
   */
  private static readonly VISITS_MAX_ZERO_RATIO = Number(
    process.env.VISITS_MAX_ZERO_RATIO ?? 0.9,
  );

  /** Espera cuando Meli limita y no dice cuanto. */
  private static readonly RATE_LIMIT_FALLBACK_SECONDS = Number(
    process.env.MELI_RATE_LIMIT_FALLBACK_SECONDS ?? 60,
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
   * Resuelve las visitas de un lote con una sola llamada al proxy.
   *
   * Antes era una llamada por publicacion. Meli limita ese endpoint y nos
   * devolvia 429 en ~40% de los pedidos; con el backoff, la pasada completa
   * tardaba unas 69 horas y nunca terminaba en el dia. El proxy ahora expone
   * GET /meli/items/visits?ids=... con hasta 500 ids, asi que el mismo trabajo
   * son ~2.500 pedidos y entra en una pasada de minutos.
   *
   * Lo que el proxy no devuelva se omite en silencio a proposito: no se
   * escribe un 0, porque un 0 escrito es indistinguible de "no tiene visitas"
   * y pisaria el ultimo valor bueno. Al no tocarle el captured_at, la
   * publicacion vuelve a entrar en la seleccion de la pasada siguiente.
   */
  private async syncVisitsChunk(
    job: Job<CatalogBackfillVisitsChunkPayload>,
  ): Promise<void> {
    const payload = job.data;
    const items = payload.items ?? [];

    if (!items.length) return;

    await this.logJob(job, `[visits-chunk] start items=${items.length}`);

    const sellerId = items[0].sellerId;
    const itemIds = items.map((item) => item.itemId);

    const response = await this.getFromMeliWithRetry<
      { item_id: string; total: number }[]
    >('/meli/items/visits', { params: { ids: itemIds.join(',') } });

    const visits = (Array.isArray(response) ? response : []).filter(
      (visit) => visit && typeof visit.item_id === 'string',
    );

    // Un lote casi todo en cero no es un lote de publicaciones sin trafico:
    // es Meli limitando y el proxy devolviendo 0 en vez de error. Escribirlo
    // pisa valores buenos, asi que se descarta entero y se reintenta.
    const zeros = visits.filter(
      (visit) => Number(visit.total ?? 0) === 0,
    ).length;
    const zeroRatio = visits.length ? zeros / visits.length : 0;

    if (
      visits.length &&
      zeroRatio > ProcessCatalogBackfill.VISITS_MAX_ZERO_RATIO
    ) {
      await this.logJob(
        job,
        `[visits-chunk] DESCARTADO requested=${itemIds.length} returned=${visits.length} zeros=${zeros} ratio=${zeroRatio.toFixed(3)}`,
      );

      throw new Error(
        `visits bulk looks unreliable: ${zeros}/${visits.length} came back as 0 (max ratio ${ProcessCatalogBackfill.VISITS_MAX_ZERO_RATIO})`,
      );
    }

    if (visits.length) {
      await this.visitsRepository.upsertManyCurrentAndSnapshot({
        sellerId,
        visits,
      });
    }

    const missing = itemIds.length - visits.length;

    await this.logJob(
      job,
      `[visits-chunk] done requested=${itemIds.length} saved=${visits.length} missing=${missing} zeroRatio=${zeroRatio.toFixed(3)}`,
    );

    // Si no vino ninguna habiendo pedido, es el proxy o Meli: conviene que el
    // job falle y BullMQ lo reintente con backoff, no perder el lote entero.
    if (!visits.length) {
      throw new Error(
        `visits bulk returned nothing for ${itemIds.length} ids (first=${itemIds[0]})`,
      );
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

        // Con un 429 se espera lo que pide Meli, no el backoff propio.
        // Reintentar antes solo vuelve a chocar contra el limite y gasta cuota:
        // el proxy pide 60 s y el backoff fijo esperaba 5.
        const rateLimitWaitMs =
          error instanceof MeliApiError && error.isRateLimited
            ? (error.retryAfterSeconds ??
                ProcessCatalogBackfill.RATE_LIMIT_FALLBACK_SECONDS) * 1000
            : null;

        const delayMs = rateLimitWaitMs ?? (attempt >= 3 ? 20000 : 5000);

        // El motivo va en el log a proposito: sin el, un 500 del proxy y un
        // timeout se ven igual, y eso fue lo que hizo falta para diagnosticar
        // por que la pasada de visitas rinde seis veces menos de lo esperado.
        console.warn(
          `[ProcessCatalogBackfill] Meli request failed | url=${url} | attempt=${attempt}/${maxAttempts} | retry_in_ms=${delayMs}${
            rateLimitWaitMs ? ' | rate_limited=true' : ''
          } | reason=${error instanceof Error ? error.message : String(error)}`,
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
