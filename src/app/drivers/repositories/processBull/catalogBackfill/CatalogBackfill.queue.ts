import { Queue } from 'bullmq';
import { bullmqConnection } from 'src/app/drivers/redis/bullmq.connection';

export const CATALOG_BACKFILL_QUEUE_NAME = 'catalog-backfill';

export enum CatalogBackfillJobs {
  SCAN_ITEMS = 'scan-items',
  SYNC_DETAILS_CHUNK = 'sync-details-chunk',
  SYNC_ORDERS_FOR_ITEM = 'sync-orders-for-item',
  SYNC_VISITS_FOR_ITEM = 'sync-visits-for-item',
  SYNC_VISITS_CHUNK = 'sync-visits-chunk',
  ENQUEUE_VISITS_REFRESH = 'enqueue-visits-refresh',
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

/**
 * Un job por lote de publicaciones, no uno por publicacion.
 *
 * Con un job por publicacion, cubrir el catalogo entero son 2.080.000 jobs en
 * Redis. Eso fue lo que llevo el Redis gestionado a su tope de memoria, y con
 * la politica allkeys-lru Redis empezo a borrar claves solas: entre ellas la
 * del scheduler de visitas, que al correr una vez por hora era la menos usada
 * y la primera candidata. La recoleccion se detuvo el 06/11/2026 sin un solo
 * error en los logs.
 *
 * Agrupando de a 50 el mismo trabajo son ~42.000 jobs. Las llamadas a Meli son
 * las mismas: el proxy no tiene endpoint bulk de visitas.
 */
export type CatalogBackfillVisitsChunkPayload = {
  runId: string;
  items: { sellerId: string | number; itemId: string }[];
};

export type CatalogBackfillVisitsRefreshPayload = {
  runId: string;
  staleAfterDays: number;
  limit?: number;
  statuses?: string[];
  tiers?: {
    newWithinDays: number;
    newStaleAfterDays: number;
    visitedStaleAfterDays: number;
    restStaleAfterDays: number;
  };
};

export type CatalogBackfillPayload =
  | CatalogBackfillScanPayload
  | CatalogBackfillDetailsPayload
  | CatalogBackfillOrdersPayload
  | CatalogBackfillVisitsPayload
  | CatalogBackfillVisitsChunkPayload
  | CatalogBackfillVisitsRefreshPayload;

export const CatalogBackfillQueue = new Queue<CatalogBackfillPayload>(
  CATALOG_BACKFILL_QUEUE_NAME,
  {
    connection: bullmqConnection,
  },
);
