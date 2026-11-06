export interface MarketplaceProductInput {
  externalId: string;
  sellerSku: string;
  marketplaceSku: string | null;
  price: number;
  stock: number;
  status: string;
  raw: Record<string, unknown>;
}

export type MarketplaceProductChanges = Partial<
  Omit<MarketplaceProductInput, 'externalId'>
>;

/** Las columnas salen tal cual: el panel ya lee este formato de madre. */
export interface MarketplaceProductRow {
  id: string;
  marketplace: string;
  external_id: string;
  seller_sku: string;
  marketplace_sku: string | null;
  price: string;
  stock: number;
  status: string;
  raw_payload: Record<string, unknown>;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MarketplaceProductsFilters {
  marketplace: string;
  sku?: string;
  status?: string;
}

export interface MarketplaceProductsPage {
  limit: number;
  offset: number;
}

export interface MarketplaceProductsStatusCount {
  status: string;
  total: number;
}

export interface IMarketplaceProductsRepository {
  bulkUpsert(
    marketplace: string,
    items: MarketplaceProductInput[],
  ): Promise<void>;
  create(
    marketplace: string,
    item: MarketplaceProductInput,
  ): Promise<MarketplaceProductRow>;
  findById(id: string): Promise<MarketplaceProductRow | null>;
  update(
    id: string,
    changes: MarketplaceProductChanges,
  ): Promise<MarketplaceProductRow | null>;
  delete(id: string): Promise<boolean>;
  existsBySellerSku(marketplace: string, sellerSku: string): Promise<boolean>;
  list(
    filters: MarketplaceProductsFilters,
    page: MarketplaceProductsPage,
  ): Promise<MarketplaceProductRow[]>;
  countByStatus(
    filters: MarketplaceProductsFilters,
  ): Promise<MarketplaceProductsStatusCount[]>;
}
