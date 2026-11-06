export interface MarketplaceSyncRunProgress {
  batches: number;
  items: number;
  failed: number;
}

export interface MarketplaceSyncRunRow {
  id: string;
  marketplace: string;
  status: string;
  batches_processed: number;
  items_processed: number;
  items_failed: number;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
}

export interface IMarketplaceSyncRunsRepository {
  start(marketplace: string): Promise<{ id: string; startedAt: Date }>;
  increment(id: string, progress: MarketplaceSyncRunProgress): Promise<boolean>;
  finish(id: string, status: string): Promise<boolean>;
  fail(id: string, errorMessage: string): Promise<boolean>;
  list(
    marketplace: string,
    page: { limit: number; offset: number },
  ): Promise<MarketplaceSyncRunRow[]>;
}
