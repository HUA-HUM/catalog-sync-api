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

class ResumeDetailsDto {
  limit?: number;
  detailChunkSize?: number;
  includeOrders?: boolean;
  includeVisits?: boolean;
}

class ResumeOrdersDto {
  limit?: number;
  orderPageLimit?: number;
}

class ResumeVisitsDto {
  limit?: number;
}

class RefreshVisitsDto {
  staleAfterDays?: number;
  limit?: number;
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
        detailChunkSize: 20,
        includeOrders: true,
        includeVisits: true,
      },
    },
  })
  start(@Body() body: StartCatalogBackfillDto) {
    return this.service.startFullBackfill(body);
  }

  @Post('details/resume-missing')
  @ApiOperation({
    summary: 'Encola detalles para MLAs que ya estan en Postgres pero no tienen detalle',
  })
  @ApiBody({
    schema: {
      example: {
        detailChunkSize: 20,
        includeOrders: true,
        includeVisits: false,
      },
    },
  })
  resumeMissingDetails(@Body() body: ResumeDetailsDto) {
    return this.service.enqueueMissingDetails({
      limit: body.limit,
      detailChunkSize: body.detailChunkSize,
      includeOrders: body.includeOrders,
      includeVisits: body.includeVisits,
    });
  }

  @Post('orders/resume')
  @ApiOperation({
    summary: 'Encola ordenes para productos sincronizados con ventas',
  })
  @ApiBody({
    schema: {
      example: {
        orderPageLimit: 50,
      },
    },
  })
  resumeOrders(@Body() body: ResumeOrdersDto) {
    return this.service.enqueueOrders({
      limit: body.limit,
      orderPageLimit: body.orderPageLimit,
    });
  }

  @Post('visits/resume-missing')
  @ApiOperation({
    summary: 'Encola visitas para productos sincronizados sin visitas guardadas',
  })
  @ApiBody({
    schema: {
      example: {},
    },
  })
  resumeMissingVisits(@Body() body: ResumeVisitsDto) {
    return this.service.enqueueMissingVisits({
      limit: body.limit,
    });
  }

  @Post('visits/refresh')
  @ApiOperation({
    summary: 'Encola visitas faltantes o vencidas por antiguedad',
  })
  @ApiBody({
    schema: {
      example: {
        staleAfterDays: 4,
        limit: 50000,
      },
    },
  })
  refreshVisits(@Body() body: RefreshVisitsDto) {
    return this.service.enqueueVisitsRefresh({
      staleAfterDays: body.staleAfterDays,
      limit: body.limit,
    });
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
