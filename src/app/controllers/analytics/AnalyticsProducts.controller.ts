import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Productos')
@Controller('analytics/products')
export class AnalyticsProductsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('performance')
  @ApiOperation({
    summary: 'Performance cruzada por producto desde analytics.product_performance',
  })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'brand', required: false, example: 'Cosori' })
  @ApiQuery({ name: 'categoryId', required: false, example: 'MLA456045' })
  performance(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('brand') brand?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.service.getProductPerformance({
      limit,
      offset,
      brand,
      categoryId,
    });
  }
}
