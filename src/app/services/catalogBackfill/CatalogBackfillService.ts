import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { IMeliHttpClient } from 'src/core/adapters/mercadolibre-api/http/IMeliHttpClient';
import type {
  IUpsertMeliCatalogRepository,
  MeliBulkProduct,
} from 'src/core/adapters/postgres/catalog/IUpsertMeliCatalogRepository';
import {
  CatalogBackfillJobs,
  CatalogBackfillQueue,
} from 'src/app/drivers/repositories/processBull/catalogBackfill/CatalogBackfill.queue';

type ScanProductsResponse = {
  seller_id: string | number;
  items: string[];
  scroll_id?: string;
  pagination?: {
    limit?: number;
    offset?: number;
    total?: number;
    has_next?: boolean;
  };
};

@Injectable()
export class CatalogBackfillService {
  constructor(
    @Inject('IMeliHttpClient')
    private readonly meliHttpClient: IMeliHttpClient,

    @Inject('IUpsertMeliCatalogRepository')
    private readonly catalogRepository: IUpsertMeliCatalogRepository,
  ) {}

  async startFullBackfill(params: {
    limit?: number;
    detailChunkSize?: number;
    maxPages?: number;
    maxItems?: number;
    includeOrders?: boolean;
    includeVisits?: boolean;
  }) {
    const runId = `catalog-backfill-${Date.now()}`;
    const limit = params.limit ?? 50;
    const detailChunkSize = params.detailChunkSize ?? 50;

    if (limit <= 0 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    if (detailChunkSize <= 0 || detailChunkSize > 20) {
      throw new BadRequestException('detailChunkSize must be between 1 and 20');
    }

    const job = await CatalogBackfillQueue.add(
      CatalogBackfillJobs.SCAN_ITEMS,
      {
        runId,
        limit,
        detailChunkSize,
        maxPages: params.maxPages,
        maxItems: params.maxItems,
        includeOrders: params.includeOrders ?? true,
        includeVisits: params.includeVisits ?? true,
      },
      {
        jobId: `${runId}-scan`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return {
      status: 'queued',
      run_id: runId,
      job_id: job.id,
      queue: 'catalog-backfill',
      limit,
      detail_chunk_size: detailChunkSize,
      include_orders: params.includeOrders ?? true,
      include_visits: params.includeVisits ?? true,
      max_pages: params.maxPages,
      max_items: params.maxItems,
    };
  }

  async enqueueMissingDetails(params: {
    limit?: number;
    detailChunkSize?: number;
    includeOrders?: boolean;
    includeVisits?: boolean;
  }) {
    const runId = `catalog-details-resume-${Date.now()}`;
    const detailChunkSize = params.detailChunkSize ?? 50;

    this.validateOptionalLimit(params.limit);

    if (detailChunkSize <= 0 || detailChunkSize > 20) {
      throw new BadRequestException('detailChunkSize must be between 1 and 20');
    }

    const items = await this.catalogRepository.findItemsMissingDetails(
      params.limit,
    );
    const chunks = this.chunkBySeller(items, detailChunkSize);

    for (const chunk of chunks) {
      await CatalogBackfillQueue.add(
        CatalogBackfillJobs.SYNC_DETAILS_CHUNK,
        {
          runId,
          sellerId: chunk.sellerId,
          itemIds: chunk.itemIds,
          includeOrders: params.includeOrders ?? true,
          includeVisits: params.includeVisits ?? false,
        },
        {
          jobId: `${runId}-details-${chunk.itemIds[0]}-${chunk.itemIds.length}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    return {
      status: 'queued',
      run_id: runId,
      queue: 'catalog-backfill',
      missing_detail_items: items.length,
      detail_jobs: chunks.length,
      detail_chunk_size: detailChunkSize,
      include_orders: params.includeOrders ?? true,
      include_visits: params.includeVisits ?? false,
    };
  }

  async enqueueOrders(params: { limit?: number; orderPageLimit?: number }) {
    const runId = `catalog-orders-resume-${Date.now()}`;
    const orderPageLimit = params.orderPageLimit ?? 50;

    this.validateOptionalLimit(params.limit);

    if (orderPageLimit <= 0 || orderPageLimit > 100) {
      throw new BadRequestException('orderPageLimit must be between 1 and 100');
    }

    const items = await this.catalogRepository.findItemsForOrders(params.limit);

    for (const item of items) {
      await CatalogBackfillQueue.add(
        CatalogBackfillJobs.SYNC_ORDERS_FOR_ITEM,
        {
          runId,
          sellerId: item.sellerId,
          itemId: item.itemId,
          status: 'paid',
          limit: orderPageLimit,
        },
        {
          jobId: `${runId}-orders-${item.itemId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    return {
      status: 'queued',
      run_id: runId,
      queue: 'catalog-backfill',
      order_items: items.length,
      order_jobs: items.length,
      order_page_limit: orderPageLimit,
    };
  }

  async enqueueMissingVisits(params: { limit?: number }) {
    const runId = `catalog-visits-resume-${Date.now()}`;

    this.validateOptionalLimit(params.limit);

    const items = await this.catalogRepository.findItemsForVisits(params.limit);

    for (const item of items) {
      await CatalogBackfillQueue.add(
        CatalogBackfillJobs.SYNC_VISITS_FOR_ITEM,
        {
          runId,
          sellerId: item.sellerId,
          itemId: item.itemId,
        },
        {
          jobId: `${runId}-visits-${item.itemId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    return {
      status: 'queued',
      run_id: runId,
      queue: 'catalog-backfill',
      visit_items: items.length,
      visit_jobs: items.length,
    };
  }

  async scanItemsPage(params: { limit?: number; scrollId?: string }) {
    const limit = params.limit ?? 50;

    if (limit <= 0 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const response = await this.meliHttpClient.get<ScanProductsResponse>(
      '/mercadolibre/products',
      {
        params: {
          useScan: true,
          limit,
          offset: params.scrollId ? undefined : 0,
          scrollId: params.scrollId || undefined,
          scroll_id: params.scrollId || undefined,
        },
      },
    );

    await this.catalogRepository.upsertPendingItems({
      sellerId: response.seller_id,
      itemIds: response.items ?? [],
    });

    return {
      seller_id: response.seller_id,
      saved_pending_items: response.items?.length ?? 0,
      items: response.items ?? [],
      scroll_id: response.scroll_id,
      pagination: response.pagination,
    };
  }

  async syncDetailsByIds(ids: string[]) {
    const cleanIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];

    if (!cleanIds.length) {
      throw new BadRequestException('ids is required');
    }

    if (cleanIds.length > 100) {
      throw new BadRequestException('ids max length is 100');
    }

    const products = await this.meliHttpClient.get<MeliBulkProduct[]>(
      '/meli/products/bulk',
      {
        params: {
          ids: cleanIds.join(','),
        },
      },
    );

    await this.catalogRepository.upsertProducts(products);

    return {
      requested: cleanIds.length,
      synced: products.length,
      item_ids: products.map((product) => product.id),
    };
  }

  private validateOptionalLimit(limit?: number) {
    if (limit !== undefined && limit <= 0) {
      throw new BadRequestException('limit must be greater than 0');
    }
  }

  private chunkBySeller(
    items: {
      sellerId: number;
      itemId: string;
    }[],
    chunkSize: number,
  ): {
    sellerId: number;
    itemIds: string[];
  }[] {
    const chunks: {
      sellerId: number;
      itemIds: string[];
    }[] = [];
    const bySeller = new Map<number, string[]>();

    for (const item of items) {
      const sellerItems = bySeller.get(item.sellerId) ?? [];
      sellerItems.push(item.itemId);
      bySeller.set(item.sellerId, sellerItems);
    }

    for (const [sellerId, itemIds] of bySeller) {
      for (let i = 0; i < itemIds.length; i += chunkSize) {
        chunks.push({
          sellerId,
          itemIds: itemIds.slice(i, i + chunkSize),
        });
      }
    }

    return chunks;
  }
}
