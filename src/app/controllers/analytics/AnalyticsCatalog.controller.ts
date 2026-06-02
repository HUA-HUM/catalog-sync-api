import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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
