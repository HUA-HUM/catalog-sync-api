import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Visitas y Conversion')
@Controller('analytics/visits')
export class AnalyticsVisitsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('top-products')
  @ApiOperation({
    summary: 'Productos con mas visitas cruzados con ventas',
  })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  topProducts(@Query('limit') limit?: string) {
    return this.service.getTopVisitedProducts(limit);
  }

  @Get('conversion-by-category')
  @ApiOperation({
    summary: 'Conversion por categoria usando visitas y ordenes',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  conversionByCategory(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getConversionByCategory({ from, to });
  }
}
