export type MeliBulkProduct = {
  id: string;
  categoryId?: string | null;
  title?: string | null;
  price?: number | null;
  currency?: string | null;
  stock?: number | null;
  soldQuantity?: number | null;
  status?: string | null;
  condition?: string | null;
  buyingMode?: string | null;
  listingTypeId?: string | null;
  permalink?: string | null;
  thumbnailId?: string | null;
  thumbnail?: string | null;
  pictures?: string[] | null;
  sellerSku?: string | null;
  brand?: string | null;
  warranty?: string | null;
  freeShipping?: boolean | null;
  health?: number | null;
  lastUpdated?: string | null;
  description?: string | null;
  site_id?: string | null;
  family_name?: string | null;
  family_id?: number | null;
  seller_id?: number | string | null;
  user_product_id?: string | null;
  official_store_id?: number | null;
  base_price?: number | null;
  original_price?: number | null;
  inventory_id?: string | null;
  initial_quantity?: number | null;
  available_quantity?: number | null;
  sale_terms?: unknown[] | null;
  start_time?: string | null;
  stop_time?: string | null;
  end_time?: string | null;
  expiration_time?: string | null;
  date_created?: string | null;
  last_updated?: string | null;
  video_id?: string | null;
  accepts_mercadopago?: boolean | null;
  shipping?: unknown | null;
  international_delivery_mode?: string | null;
  attributes?: MeliBulkProductAttribute[] | null;
  variations?: MeliBulkProductVariation[] | null;
  sub_status?: unknown[] | null;
  tags?: unknown[] | null;
  catalog_product_id?: string | null;
  domain_id?: string | null;
  seller_custom_field?: string | null;
  parent_item_id?: string | null;
  automatic_relist?: boolean | null;
  catalog_listing?: boolean | null;
  channels?: unknown[] | null;
  warnings?: unknown[] | null;
  item_relations?: unknown[] | null;
  deal_ids?: unknown[] | null;
};

export type MeliBulkProductAttribute = {
  id: string;
  name?: string | null;
  value_id?: string | null;
  value_name?: string | null;
  value_type?: string | null;
  values?: unknown[] | null;
};

export type MeliBulkProductVariation = {
  id?: string | number | null;
  variation_id?: string | number | null;
  sellerSku?: string | null;
  seller_sku?: string | null;
  price?: number | null;
  available_quantity?: number | null;
  sold_quantity?: number | null;
  attributes?: unknown[] | null;
  attribute_combinations?: unknown[] | null;
};

export type MeliCatalogSyncAudit = {
  date: string;
  timezone: string;
  startAt: Date;
  endAt: Date;
  counts: {
    itemsSynced: number;
    itemRowsUpdated: number;
    detailsSynced: number;
    ordersUpdated: number;
    visitsCaptured: number;
    visitSnapshots: number;
  };
  recentItems: {
    itemId: string;
    title: string | null;
    price: number | null;
    stock: number | null;
    soldQuantity: number | null;
    status: string | null;
    lastUpdated: Date | null;
    lastSyncedAt: Date | null;
    updatedAt: Date | null;
  }[];
};

export interface IUpsertMeliCatalogRepository {
  upsertProducts(products: MeliBulkProduct[]): Promise<void>;
  upsertPendingItems(params: {
    sellerId: number | string;
    itemIds: string[];
  }): Promise<void>;
  findItemsMissingDetails(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  >;
  findItemsForOrders(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  >;
  findItemsForVisits(limit?: number): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  >;
  findItemsForVisitsRefresh(params: {
    staleAfterDays: number;
    limit?: number;
  }): Promise<
    {
      sellerId: number;
      itemId: string;
    }[]
  >;
  getDailySyncAudit(params: {
    date?: string;
    timezone: string;
    recentLimit: number;
  }): Promise<MeliCatalogSyncAudit>;
}
