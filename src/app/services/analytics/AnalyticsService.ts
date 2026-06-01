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
}
