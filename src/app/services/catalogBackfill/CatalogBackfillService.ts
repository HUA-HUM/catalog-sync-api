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
    const limit = params.limit ?? 100;
    const detailChunkSize = params.detailChunkSize ?? 50;

    if (limit <= 0 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    if (detailChunkSize <= 0 || detailChunkSize > 100) {
      throw new BadRequestException('detailChunkSize must be between 1 and 100');
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
          scrollId: params.scrollId,
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
}
