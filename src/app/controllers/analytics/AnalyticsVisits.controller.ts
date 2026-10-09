import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { InternalApiKeyGuard } from 'src/app/guards/InternalApiKey.guard';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

class VisitsBulkDto {
  ids: string[];
}

@ApiTags('Analytics - Visitas y Conversion')
@Controller('analytics/visits')
export class AnalyticsVisitsController {
  constructor(private readonly service: AnalyticsService) {}

  @Post('bulk')
  @UseGuards(InternalApiKeyGuard)
  @ApiSecurity('internal-api-key')
  @ApiOperation({
    summary: 'Visitas de muchos MLAs en una sola pegada',
    description:
      'Lee meli_item_visits_current, no la vista materializada. Es POST y no GET porque un listado grande de MLAs no entra en la query string. Maximo 10000 ids por request.',
  })
  @ApiBody({
    schema: {
      example: {
        ids: ['MLA3770706662', 'MLA3777311668', 'MLA3454331720'],
      },
    },
  })
  visitsBulk(@Body() body: VisitsBulkDto) {
    return this.service.getProductsVisitsBulk(body?.ids);
  }

  @Get('catalog')
  @UseGuards(InternalApiKeyGuard)
  @ApiSecurity('internal-api-key')
  @ApiOperation({
    summary: 'Recorre las visitas de todo el catalogo con cursor',
    description:
      'Paginado por keyset sobre item_id, no por offset: el tiempo de respuesta no se degrada al avanzar. Pasar next_cursor de la respuesta anterior como afterItemId para traer la pagina siguiente.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 1000 })
  @ApiQuery({
    name: 'afterItemId',
    required: false,
    description:
      'next_cursor de la respuesta anterior. Vacio para la primera pagina.',
    example: 'MLA1234567890',
  })
  visitsCatalog(
    @Query('limit') limit?: string,
    @Query('afterItemId') afterItemId?: string,
  ) {
    return this.service.getProductsVisitsPage({ limit, afterItemId });
  }

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
  conversionByCategory(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getConversionByCategory({ from, to });
  }
}
