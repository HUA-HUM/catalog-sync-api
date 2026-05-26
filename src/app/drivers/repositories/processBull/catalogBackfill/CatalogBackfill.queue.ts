import { Queue } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';

export const CATALOG_BACKFILL_QUEUE_NAME = 'catalog-backfill';

export enum CatalogBackfillJobs {
  SCAN_ITEMS = 'scan-items',
  SYNC_DETAILS_CHUNK = 'sync-details-chunk',
  SYNC_ORDERS_FOR_ITEM = 'sync-orders-for-item',
  SYNC_VISITS_FOR_ITEM = 'sync-visits-for-item',
}

export type CatalogBackfillScanPayload = {
  runId: string;
  limit: number;
  detailChunkSize: number;
  maxPages?: number;
  maxItems?: number;
  includeOrders: boolean;
  includeVisits: boolean;
};

export type CatalogBackfillDetailsPayload = {
  runId: string;
  sellerId: string | number;
  itemIds: string[];
  includeOrders: boolean;
  includeVisits: boolean;
};

export type CatalogBackfillOrdersPayload = {
  runId: string;
  sellerId: string | number;
  itemId: string;
  status: string;
  limit: number;
};

export type CatalogBackfillVisitsPayload = {
  runId: string;
  sellerId: string | number;
  itemId: string;
};

export type CatalogBackfillPayload =
  | CatalogBackfillScanPayload
  | CatalogBackfillDetailsPayload
  | CatalogBackfillOrdersPayload
  | CatalogBackfillVisitsPayload;

export const CatalogBackfillQueue = new Queue<CatalogBackfillPayload>(
  CATALOG_BACKFILL_QUEUE_NAME,
  {
    connection: bullmqConnection,
  },
);
