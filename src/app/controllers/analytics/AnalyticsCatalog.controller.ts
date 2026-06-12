import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@ApiTags('Analytics - Catalogo')
@Controller('analytics/catalog')
export class AnalyticsCatalogController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen general del catalogo de publicaciones',
  })
  summary() {
    return this.service.getCatalogSummary();
  }

  @Get('table-freshness')
  @ApiOperation({
    summary:
      'Ultima actualizacion y estado de frescura de cada tabla de public y analytics',
  })
  @ApiQuery({
    name: 'staleAfterHours',
    required: false,
    example: 24,
    description:
      'Una tabla queda stale cuando su ultima actualizacion supera estas horas',
  })
  tableFreshness(@Query('staleAfterHours') staleAfterHours?: string) {
    return this.service.getTableFreshness(staleAfterHours);
  }

  @Get('age')
  @ApiOperation({
    summary: 'Distribucion por fecha de creacion de publicaciones',
  })
  age() {
    return this.service.getCatalogAge();
  }

  @Get('missing-data')
  @ApiOperation({
    summary: 'Auditoria de productos con datos faltantes',
  })
  missingData() {
    return this.service.getMissingData();
  }
}
