import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AnalyticsDateRange,
  CategoryHistoryGranularity,
  CategoryHistoryQuery,
  CategoryListQuery,
  CategoryPerformanceQuery,
  CategoryPublicationsQuery,
  CategoryRevenueQuery,
  CategoryVisitsQuery,
  IAnalyticsRepository,
  ProductPerformanceQuery,
  ProductPerformanceSortField,
} from 'src/core/adapters/postgres/analytics/IAnalyticsRepository';
import { PRODUCT_PERFORMANCE_SORT_FIELDS } from 'src/core/adapters/postgres/analytics/IAnalyticsRepository';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject('IAnalyticsRepository')
    private readonly analyticsRepository: IAnalyticsRepository,
  ) {}

  getCatalogSummary() {
    return this.analyticsRepository.getCatalogSummary();
  }

  getTableFreshness(staleAfterHours?: string) {
    const parsedStaleAfterHours = this.parseNumber(
      staleAfterHours,
      'staleAfterHours',
      {
        defaultValue: 24,
        min: 1,
        max: 8760,
        integer: true,
      },
    );

    return this.analyticsRepository.getTableFreshness(parsedStaleAfterHours);
  }

  getCatalogAge() {
    return this.analyticsRepository.getCatalogAge();
  }

  getMissingData() {
    return this.analyticsRepository.getMissingData();
  }

  getCategories(params: { limit?: string; offset?: string; search?: string }) {
    const query: CategoryListQuery = {
      limit: this.parseNumber(params.limit, 'limit', {
        defaultValue: 1000,
        min: 1,
        max: 10000,
        integer: true,
      }),
      offset: this.parseNumber(params.offset, 'offset', {
        defaultValue: 0,
        min: 0,
        integer: true,
      }),
      search: this.parseText(params.search),
    };

    return this.analyticsRepository.getCategories(query);
  }

  getCategoryPublications(
    categoryId: string | undefined,
    params: {
      domainId?: string;
    },
  ) {
    const parsedCategoryId = this.parseText(categoryId);
    if (!parsedCategoryId) {
      throw new BadRequestException('categoryId is required');
    }

    const query: CategoryPublicationsQuery = {
      categoryId: parsedCategoryId,
      domainId: this.parseText(params.domainId),
    };

    return this.analyticsRepository.getCategoryPublications(query);
  }

  getCategoryVisits(
    categoryId: string | undefined,
    params: {
      domainId?: string;
    },
  ) {
    const parsedCategoryId = this.parseText(categoryId);
    if (!parsedCategoryId) {
      throw new BadRequestException('categoryId is required');
    }

    const query: CategoryVisitsQuery = {
      categoryId: parsedCategoryId,
      domainId: this.parseText(params.domainId),
    };

    return this.analyticsRepository.getCategoryVisits(query);
  }

  getCategoryRevenue(
    categoryId: string | undefined,
    params: {
      domainId?: string;
    },
  ) {
    const parsedCategoryId = this.parseText(categoryId);
    if (!parsedCategoryId) {
      throw new BadRequestException('categoryId is required');
    }

    const query: CategoryRevenueQuery = {
      categoryId: parsedCategoryId,
      domainId: this.parseText(params.domainId),
    };

    return this.analyticsRepository.getCategoryRevenue(query);
  }

  getCategoryTree() {
    return this.analyticsRepository.getCategoryTree();
  }

  getCategoryPerformance(params: {
    from?: string;
    to?: string;
    limit?: string;
    offset?: string;
  }) {
    const query: CategoryPerformanceQuery = {
      from: this.parseDate(params.from, 'from'),
      to: this.parseDate(params.to, 'to'),
      limit: this.parseNumber(params.limit, 'limit', {
        defaultValue: 100,
        min: 1,
        max: 1000,
        integer: true,
      }),
      offset: this.parseNumber(params.offset, 'offset', {
        defaultValue: 0,
        min: 0,
        integer: true,
      }),
    };

    return this.analyticsRepository.getCategoryPerformance(query);
  }

  getCategoryHistory(params: {
    from?: string;
    to?: string;
    granularity?: string;
    limit?: string;
    offset?: string;
  }) {
    const query: CategoryHistoryQuery = {
      from: this.parseDate(params.from, 'from'),
      to: this.parseDate(params.to, 'to'),
      granularity: this.parseCategoryHistoryGranularity(params.granularity),
      limit: this.parseNumber(params.limit, 'limit', {
        defaultValue: 25,
        min: 1,
        max: 250,
        integer: true,
      }),
      offset: this.parseNumber(params.offset, 'offset', {
        defaultValue: 0,
        min: 0,
        integer: true,
      }),
    };

    return this.analyticsRepository.getCategoryHistory(query);
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

    if (
      !Number.isFinite(parsedLimit) ||
      parsedLimit <= 0 ||
      parsedLimit > 1000
    ) {
      throw new BadRequestException('limit must be between 1 and 1000');
    }

    return this.analyticsRepository.getTopVisitedProducts(parsedLimit);
  }

  getConversionByCategory(range: AnalyticsDateRange) {
    return this.analyticsRepository.getConversionByCategory(range);
  }

  getProductPerformance(params: { [key: string]: string | undefined }) {
    const query: ProductPerformanceQuery = {
      limit: this.parseNumber(params.limit, 'limit', {
        defaultValue: 100,
        min: 1,
        max: 1000,
        integer: true,
      }),
      offset: this.parseNumber(params.offset, 'offset', {
        defaultValue: 0,
        min: 0,
        integer: true,
      }),
      search: this.parseText(params.search),
      sellerId: this.parseOptionalNumber(params.sellerId, 'sellerId', {
        min: 1,
        integer: true,
      }),
      itemId: this.parseText(params.itemId),
      sku: this.parseText(params.sku),
      skuPrefix: this.parseText(params.skuPrefix),
      brands: this.parseList(params.brand),
      categoryIds: this.parseList(params.categoryId),
      domainIds: this.parseList(params.domainId),
      listingTypeIds: this.parseList(params.listingTypeId),
      statuses: this.parseList(params.status),
      conditions: this.parseList(params.condition),
      currencyId: this.parseText(params.currencyId),
      createdFrom: this.parseDate(params.createdFrom, 'createdFrom'),
      createdTo: this.parseDate(params.createdTo, 'createdTo'),
      firstOrderFrom: this.parseDate(params.firstOrderFrom, 'firstOrderFrom'),
      firstOrderTo: this.parseDate(params.firstOrderTo, 'firstOrderTo'),
      lastOrderFrom: this.parseDate(params.lastOrderFrom, 'lastOrderFrom'),
      lastOrderTo: this.parseDate(params.lastOrderTo, 'lastOrderTo'),
      minPrice: this.parseOptionalNumber(params.minPrice, 'minPrice'),
      maxPrice: this.parseOptionalNumber(params.maxPrice, 'maxPrice'),
      minStock: this.parseOptionalNumber(params.minStock, 'minStock'),
      maxStock: this.parseOptionalNumber(params.maxStock, 'maxStock'),
      minAvailableQuantity: this.parseOptionalNumber(
        params.minAvailableQuantity,
        'minAvailableQuantity',
      ),
      maxAvailableQuantity: this.parseOptionalNumber(
        params.maxAvailableQuantity,
        'maxAvailableQuantity',
      ),
      minCatalogSoldQuantity: this.parseOptionalNumber(
        params.minCatalogSoldQuantity,
        'minCatalogSoldQuantity',
      ),
      maxCatalogSoldQuantity: this.parseOptionalNumber(
        params.maxCatalogSoldQuantity,
        'maxCatalogSoldQuantity',
      ),
      minVisits: this.parseOptionalNumber(params.minVisits, 'minVisits'),
      maxVisits: this.parseOptionalNumber(params.maxVisits, 'maxVisits'),
      minOrders: this.parseOptionalNumber(params.minOrders, 'minOrders'),
      maxOrders: this.parseOptionalNumber(params.maxOrders, 'maxOrders'),
      minUnitsSold: this.parseOptionalNumber(
        params.minUnitsSold,
        'minUnitsSold',
      ),
      maxUnitsSold: this.parseOptionalNumber(
        params.maxUnitsSold,
        'maxUnitsSold',
      ),
      minRevenue: this.parseOptionalNumber(params.minRevenue, 'minRevenue'),
      maxRevenue: this.parseOptionalNumber(params.maxRevenue, 'maxRevenue'),
      minAvgTicket: this.parseOptionalNumber(
        params.minAvgTicket,
        'minAvgTicket',
      ),
      maxAvgTicket: this.parseOptionalNumber(
        params.maxAvgTicket,
        'maxAvgTicket',
      ),
      minDaysToFirstOrder: this.parseOptionalNumber(
        params.minDaysToFirstOrder,
        'minDaysToFirstOrder',
      ),
      maxDaysToFirstOrder: this.parseOptionalNumber(
        params.maxDaysToFirstOrder,
        'maxDaysToFirstOrder',
      ),
      minOrderConversionRate: this.parseOptionalNumber(
        params.minOrderConversionRate,
        'minOrderConversionRate',
      ),
      maxOrderConversionRate: this.parseOptionalNumber(
        params.maxOrderConversionRate,
        'maxOrderConversionRate',
      ),
      minUnitConversionRate: this.parseOptionalNumber(
        params.minUnitConversionRate,
        'minUnitConversionRate',
      ),
      maxUnitConversionRate: this.parseOptionalNumber(
        params.maxUnitConversionRate,
        'maxUnitConversionRate',
      ),
      hasOrders: this.parseBoolean(params.hasOrders, 'hasOrders'),
      hasVisits: this.parseBoolean(params.hasVisits, 'hasVisits'),
      sortBy: this.parseSortField(params.sortBy),
      sortOrder: this.parseSortOrder(params.sortOrder),
    };

    this.validateRange(query, 'price');
    this.validateRange(query, 'stock');
    this.validateRange(query, 'availableQuantity');
    this.validateRange(query, 'catalogSoldQuantity');
    this.validateRange(query, 'visits');
    this.validateRange(query, 'orders');
    this.validateRange(query, 'unitsSold');
    this.validateRange(query, 'revenue');
    this.validateRange(query, 'avgTicket');
    this.validateRange(query, 'daysToFirstOrder');
    this.validateRange(query, 'orderConversionRate');
    this.validateRange(query, 'unitConversionRate');

    return this.analyticsRepository.getProductPerformance(query);
  }

  private parseText(value?: string): string | undefined {
    const parsed = value?.trim();
    return parsed || undefined;
  }

  private parseList(value?: string): string[] | undefined {
    if (!value) return undefined;

    const parsed = [
      ...new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    if (parsed.length > 100) {
      throw new BadRequestException('list filters allow at most 100 values');
    }

    return parsed.length ? parsed : undefined;
  }

  private parseNumber(
    value: string | undefined,
    field: string,
    options: {
      defaultValue: number;
      min?: number;
      max?: number;
      integer?: boolean;
    },
  ): number {
    if (value === undefined || value === '') return options.defaultValue;
    return this.validateNumber(Number(value), field, options);
  }

  private parseOptionalNumber(
    value: string | undefined,
    field: string,
    options: { min?: number; max?: number; integer?: boolean } = {},
  ): number | undefined {
    if (value === undefined || value === '') return undefined;
    return this.validateNumber(Number(value), field, options);
  }

  private validateNumber(
    value: number,
    field: string,
    options: { min?: number; max?: number; integer?: boolean },
  ): number {
    if (
      !Number.isFinite(value) ||
      (options.integer && !Number.isInteger(value)) ||
      (options.min !== undefined && value < options.min) ||
      (options.max !== undefined && value > options.max)
    ) {
      throw new BadRequestException(`${field} has an invalid value`);
    }

    return value;
  }

  private parseDate(
    value: string | undefined,
    field: string,
  ): string | undefined {
    if (!value) return undefined;
    if (Number.isNaN(new Date(value).getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO date`);
    }
    return value;
  }

  private parseBoolean(
    value: string | undefined,
    field: string,
  ): boolean | undefined {
    if (value === undefined || value === '') return undefined;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new BadRequestException(`${field} must be true or false`);
  }

  private parseSortField(value?: string): ProductPerformanceSortField {
    const sortBy = value || 'revenue';
    if (
      !PRODUCT_PERFORMANCE_SORT_FIELDS.includes(
        sortBy as ProductPerformanceSortField,
      )
    ) {
      throw new BadRequestException(
        `sortBy must be one of: ${PRODUCT_PERFORMANCE_SORT_FIELDS.join(', ')}`,
      );
    }
    return sortBy as ProductPerformanceSortField;
  }

  private parseSortOrder(value?: string): 'asc' | 'desc' {
    const sortOrder = (value || 'desc').toLowerCase();
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      throw new BadRequestException('sortOrder must be asc or desc');
    }
    return sortOrder;
  }

  private parseCategoryHistoryGranularity(
    value?: string,
  ): CategoryHistoryGranularity {
    const granularity = (value || 'month').toLowerCase();
    if (
      granularity !== 'day' &&
      granularity !== 'week' &&
      granularity !== 'month'
    ) {
      throw new BadRequestException('granularity must be day, week or month');
    }

    return granularity;
  }

  private validateRange(
    query: ProductPerformanceQuery,
    suffix:
      | 'price'
      | 'stock'
      | 'availableQuantity'
      | 'catalogSoldQuantity'
      | 'visits'
      | 'orders'
      | 'unitsSold'
      | 'revenue'
      | 'avgTicket'
      | 'daysToFirstOrder'
      | 'orderConversionRate'
      | 'unitConversionRate',
  ): void {
    const minKey =
      `min${suffix[0].toUpperCase()}${suffix.slice(1)}` as keyof ProductPerformanceQuery;
    const maxKey =
      `max${suffix[0].toUpperCase()}${suffix.slice(1)}` as keyof ProductPerformanceQuery;
    const min = query[minKey] as number | undefined;
    const max = query[maxKey] as number | undefined;

    if (min !== undefined && max !== undefined && min > max) {
      throw new BadRequestException(
        `${String(minKey)} cannot be greater than ${String(maxKey)}`,
      );
    }
  }
}
