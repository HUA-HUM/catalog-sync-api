import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Productos')
@Controller('analytics/products')
export class AnalyticsProductsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('performance')
  @ApiOperation({
    summary:
      'Performance cruzada por producto desde analytics.product_performance',
  })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Busca por MLA, título, SKU, marca, categoría o dominio',
  })
  @ApiQuery({ name: 'sellerId', required: false, example: 1757836744 })
  @ApiQuery({ name: 'itemId', required: false, example: 'MLA1757293798' })
  @ApiQuery({ name: 'sku', required: false, example: 'B0BYZX8X9H' })
  @ApiQuery({ name: 'skuPrefix', required: false, example: 'B0' })
  @ApiQuery({
    name: 'brand',
    required: false,
    description: 'Una o varias marcas separadas por coma',
    example: 'Samsung,Sony',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description: 'Uno o varios category_id separados por coma',
    example: 'MLA1002,MLA456045',
  })
  @ApiQuery({
    name: 'domainId',
    required: false,
    description: 'Uno o varios domain_id separados por coma',
    example: 'MLA-TELEVISIONS,MLA-AIR_FRYERS',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Estados separados por coma',
    example: 'active,paused',
  })
  @ApiQuery({ name: 'condition', required: false, example: 'new' })
  @ApiQuery({ name: 'currencyId', required: false, example: 'ARS' })
  @ApiQuery({ name: 'createdFrom', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'createdTo', required: false, example: '2026-06-30' })
  @ApiQuery({ name: 'firstOrderFrom', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'firstOrderTo', required: false, example: '2026-06-30' })
  @ApiQuery({ name: 'lastOrderFrom', required: false })
  @ApiQuery({ name: 'lastOrderTo', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  @ApiQuery({ name: 'minStock', required: false })
  @ApiQuery({ name: 'maxStock', required: false })
  @ApiQuery({ name: 'minAvailableQuantity', required: false })
  @ApiQuery({ name: 'maxAvailableQuantity', required: false })
  @ApiQuery({ name: 'minCatalogSoldQuantity', required: false })
  @ApiQuery({ name: 'maxCatalogSoldQuantity', required: false })
  @ApiQuery({ name: 'minVisits', required: false })
  @ApiQuery({ name: 'maxVisits', required: false })
  @ApiQuery({ name: 'minOrders', required: false })
  @ApiQuery({ name: 'maxOrders', required: false })
  @ApiQuery({ name: 'minUnitsSold', required: false })
  @ApiQuery({ name: 'maxUnitsSold', required: false })
  @ApiQuery({ name: 'minRevenue', required: false })
  @ApiQuery({ name: 'maxRevenue', required: false })
  @ApiQuery({ name: 'minAvgTicket', required: false })
  @ApiQuery({ name: 'maxAvgTicket', required: false })
  @ApiQuery({ name: 'minDaysToFirstOrder', required: false })
  @ApiQuery({ name: 'maxDaysToFirstOrder', required: false })
  @ApiQuery({ name: 'minOrderConversionRate', required: false })
  @ApiQuery({ name: 'maxOrderConversionRate', required: false })
  @ApiQuery({ name: 'minUnitConversionRate', required: false })
  @ApiQuery({ name: 'maxUnitConversionRate', required: false })
  @ApiQuery({ name: 'hasOrders', required: false, type: Boolean })
  @ApiQuery({ name: 'hasVisits', required: false, type: Boolean })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: [
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
    ],
    example: 'revenue',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  performance(@Query() query: Record<string, string | undefined>) {
    return this.service.getProductPerformance(query);
  }
}
