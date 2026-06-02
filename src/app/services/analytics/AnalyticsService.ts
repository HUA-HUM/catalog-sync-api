import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AnalyticsDateRange,
  IAnalyticsRepository,
} from 'src/core/adapters/postgres/analytics/IAnalyticsRepository';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject('IAnalyticsRepository')
    private readonly analyticsRepository: IAnalyticsRepository,
  ) {}

  getCatalogSummary() {
    return this.analyticsRepository.getCatalogSummary();
  }

  getCatalogAge() {
    return this.analyticsRepository.getCatalogAge();
  }

  getMissingData() {
    return this.analyticsRepository.getMissingData();
  }

  getCategoryTree() {
    return this.analyticsRepository.getCategoryTree();
  }

  getCategoryPerformance(range: AnalyticsDateRange) {
    return this.analyticsRepository.getCategoryPerformance(range);
  }

  getBrandSummary(range: AnalyticsDateRange) {
    return this.analyticsRepository.getBrandSummary(range);
  }

  getBrandOrders(range: AnalyticsDateRange) {
    return this.analyticsRepository.getBrandOrders(range);
  }

  getOrdersSummary(range: AnalyticsDateRange) {
    return this.analyticsRepository.getOrdersSummary(range);
  }

  getOrdersBySku(range: AnalyticsDateRange) {
    return this.analyticsRepository.getOrdersBySku(range);
  }

  getTopVisitedProducts(limit?: string) {
    const parsedLimit = limit ? Number(limit) : 100;

    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0 || parsedLimit > 1000) {
      throw new BadRequestException('limit must be between 1 and 1000');
    }

    return this.analyticsRepository.getTopVisitedProducts(parsedLimit);
  }

  getConversionByCategory(range: AnalyticsDateRange) {
    return this.analyticsRepository.getConversionByCategory(range);
  }

  getProductPerformance(params: {
    limit?: string;
    offset?: string;
    brand?: string;
    categoryId?: string;
  }) {
    const limit = params.limit ? Number(params.limit) : 100;
    const offset = params.offset ? Number(params.offset) : 0;

    if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) {
      throw new BadRequestException('limit must be between 1 and 1000');
    }

    if (!Number.isFinite(offset) || offset < 0) {
      throw new BadRequestException('offset must be greater than or equal to 0');
    }

    return this.analyticsRepository.getProductPerformance({
      limit,
      offset,
      brand: params.brand,
      categoryId: params.categoryId,
    });
  }
}
