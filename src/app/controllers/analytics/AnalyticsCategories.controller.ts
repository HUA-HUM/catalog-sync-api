import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Categorias')
@Controller('analytics/categories')
export class AnalyticsCategoriesController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('tree')
  @ApiOperation({
    summary: 'Agrupa categorias con cantidad de productos, ventas y visitas',
  })
  tree() {
    return this.service.getCategoryTree();
  }

  @Get('performance')
  @ApiOperation({
    summary: 'Performance por categoria cruzando catalogo, ordenes y visitas',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-06-01' })
  performance(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getCategoryPerformance({ from, to });
  }
}
