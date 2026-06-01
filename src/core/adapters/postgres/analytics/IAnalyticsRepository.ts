export type AnalyticsDateRange = {
  from?: string;
  to?: string;
};

export interface IAnalyticsRepository {
  getCatalogSummary(): Promise<unknown>;
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
}
