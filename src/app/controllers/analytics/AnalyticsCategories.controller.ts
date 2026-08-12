import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Categorias')
@Controller('analytics/categories')
export class AnalyticsCategoriesController {
  constructor(private readonly service: AnalyticsService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista categorias disponibles con id y path',
  })
  @ApiQuery({ name: 'limit', required: false, example: 1000 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'search', required: false, example: 'MLA' })
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getCategories({ limit, offset, search });
  }

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
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  performance(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.getCategoryPerformance({ from, to, limit, offset });
  }

  @Get('history')
  @ApiOperation({
    summary:
      'Historico por categoria cruzando publicaciones, ordenes, ventas y visitas',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-08-01' })
  @ApiQuery({
    name: 'granularity',
    required: false,
    enum: ['day', 'week', 'month'],
    example: 'month',
  })
  @ApiQuery({ name: 'limit', required: false, example: 25 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  history(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.getCategoryHistory({
      from,
      to,
      granularity,
      limit,
      offset,
    });
  }

  @Get(':categoryId/publications')
  @ApiOperation({
    summary: 'Cantidad de publicaciones para una categoria',
  })
  @ApiParam({ name: 'categoryId', example: 'MLA1055' })
  @ApiQuery({
    name: 'domainId',
    required: false,
    description:
      'Filtra por domain_id cuando una categoria aparece en mas de un dominio',
  })
  publications(
    @Param('categoryId') categoryId: string,
    @Query('domainId') domainId?: string,
  ) {
    return this.service.getCategoryPublications(categoryId, { domainId });
  }

  @Get(':categoryId/visits')
  @ApiOperation({
    summary: 'Cantidad de visitas para una categoria',
  })
  @ApiParam({ name: 'categoryId', example: 'MLA1055' })
  @ApiQuery({
    name: 'domainId',
    required: false,
    description:
      'Filtra por domain_id cuando una categoria aparece en mas de un dominio',
  })
  visits(
    @Param('categoryId') categoryId: string,
    @Query('domainId') domainId?: string,
  ) {
    return this.service.getCategoryVisits(categoryId, { domainId });
  }
}
