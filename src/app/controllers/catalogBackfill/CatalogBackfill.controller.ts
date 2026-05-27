import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CatalogBackfillService } from 'src/app/services/catalogBackfill/CatalogBackfillService';

class ScanItemsPageDto {
  limit?: number;
  scrollId?: string;
}

class SyncDetailsByIdsDto {
  ids: string[];
}

class StartCatalogBackfillDto {
  limit?: number;
  detailChunkSize?: number;
  maxPages?: number;
  maxItems?: number;
  includeOrders?: boolean;
  includeVisits?: boolean;
}

@ApiTags('Internal - Catalog Backfill')
@Controller('internal/catalog-backfill')
export class CatalogBackfillController {
  constructor(private readonly service: CatalogBackfillService) {}

  @Post('start')
  @ApiOperation({
    summary: 'Encola la carga masiva de catálogo, detalles, órdenes y visitas',
  })
  @ApiBody({
    schema: {
      example: {
        limit: 50,
        detailChunkSize: 50,
        maxPages: 2,
        includeOrders: true,
        includeVisits: true,
      },
    },
  })
  start(@Body() body: StartCatalogBackfillDto) {
    return this.service.startFullBackfill(body);
  }

  @Post('items/scan-page')
  @ApiOperation({
    summary: 'Trae una página de MLAs desde Meli y los guarda como pending_detail',
  })
  @ApiBody({
    schema: {
      example: {
        limit: 50,
      },
    },
  })
  scanItemsPage(@Body() body: ScanItemsPageDto) {
    return this.service.scanItemsPage({
      limit: body.limit,
      scrollId: body.scrollId,
    });
  }

  @Post('items/details-by-ids')
  @ApiOperation({
    summary: 'Trae detalles bulk de MLAs y los guarda en Postgres',
  })
  @ApiBody({
    schema: {
      example: {
        ids: ['MLA1757293798', 'MLA1757293732'],
      },
    },
  })
  syncDetailsByIds(@Body() body: SyncDetailsByIdsDto) {
    return this.service.syncDetailsByIds(body.ids ?? []);
  }
}
