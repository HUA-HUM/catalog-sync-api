import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Ordenes')
@Controller('analytics/orders')
export class AnalyticsOrdersController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen de ordenes, unidades vendidas y facturacion',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getOrdersSummary({ from, to });
  }

  @Get('by-sku')
  @ApiOperation({
    summary: 'Ordenes y facturacion agrupadas por SKU',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  bySku(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getOrdersBySku({ from, to });
  }
}
