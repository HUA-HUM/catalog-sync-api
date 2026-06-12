export type AnalyticsDateRange = {
  from?: string;
  to?: string;
};

export const PRODUCT_PERFORMANCE_SORT_FIELDS = [
  'itemId',
  'title',
  'sku',
  'brand',
  'categoryId',
  'domainId',
  'status',
  'price',
  'stock',
  'availableQuantity',
  'catalogSoldQuantity',
  'dateCreated',
  'lastUpdated',
  'totalVisits',
  'ordersCount',
  'unitsSold',
  'revenue',
  'avgTicket',
  'firstOrderDate',
  'lastOrderDate',
  'daysToFirstOrder',
  'orderConversionRate',
  'unitConversionRate',
] as const;

export type ProductPerformanceSortField =
  (typeof PRODUCT_PERFORMANCE_SORT_FIELDS)[number];

export type ProductPerformanceQuery = {
  limit: number;
  offset: number;
  search?: string;
  sellerId?: number;
  itemId?: string;
  sku?: string;
  skuPrefix?: string;
  brands?: string[];
  categoryIds?: string[];
  domainIds?: string[];
  statuses?: string[];
  conditions?: string[];
  currencyId?: string;
  createdFrom?: string;
  createdTo?: string;
  firstOrderFrom?: string;
  firstOrderTo?: string;
  lastOrderFrom?: string;
  lastOrderTo?: string;
  minPrice?: number;
  maxPrice?: number;
  minStock?: number;
  maxStock?: number;
  minAvailableQuantity?: number;
  maxAvailableQuantity?: number;
  minCatalogSoldQuantity?: number;
  maxCatalogSoldQuantity?: number;
  minVisits?: number;
  maxVisits?: number;
  minOrders?: number;
  maxOrders?: number;
  minUnitsSold?: number;
  maxUnitsSold?: number;
  minRevenue?: number;
  maxRevenue?: number;
  minAvgTicket?: number;
  maxAvgTicket?: number;
  minDaysToFirstOrder?: number;
  maxDaysToFirstOrder?: number;
  minOrderConversionRate?: number;
  maxOrderConversionRate?: number;
  minUnitConversionRate?: number;
  maxUnitConversionRate?: number;
  hasOrders?: boolean;
  hasVisits?: boolean;
  sortBy: ProductPerformanceSortField;
  sortOrder: 'asc' | 'desc';
};

export interface IAnalyticsRepository {
  getCatalogSummary(): Promise<unknown>;
  getTableFreshness(staleAfterHours: number): Promise<unknown>;
  getCategoryTree(): Promise<unknown>;
  getCategoryPerformance(params: AnalyticsDateRange): Promise<unknown>;
  getBrandSummary(params: AnalyticsDateRange): Promise<unknown>;
  getBrandOrders(params: AnalyticsDateRange): Promise<unknown>;
  getOrdersSummary(params: AnalyticsDateRange): Promise<unknown>;
  getOrdersBySku(params: AnalyticsDateRange): Promise<unknown>;
  getTopVisitedProducts(limit: number): Promise<unknown>;
  getConversionByCategory(params: AnalyticsDateRange): Promise<unknown>;
  getCatalogAge(): Promise<unknown>;
  getMissingData(): Promise<unknown>;
  getProductPerformance(params: ProductPerformanceQuery): Promise<unknown>;
}
