import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Marcas')
@Controller('analytics/brands')
export class AnalyticsBrandsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Cantidad de productos, stock, visitas y facturacion por marca',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getBrandSummary({ from, to });
  }

  @Get('orders')
  @ApiOperation({
    summary: 'Cantidad de productos con ordenes y facturacion por marca',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  orders(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getBrandOrders({ from, to });
  }
}
