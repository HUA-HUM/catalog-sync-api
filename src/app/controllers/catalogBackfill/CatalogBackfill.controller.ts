import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalApiKeyGuard } from 'src/app/guards/InternalApiKey.guard';
import { CatalogBackfillService } from 'src/app/services/catalogBackfill/CatalogBackfillService';

class ScanItemsPageDto {
  limit?: number;
  scrollId?: string;
}

class SyncDetailsByIdsDto {
  ids: string[];
}

class ResyncDto {
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

class SyncAuditQueryDto {
  date?: string;
  timezone?: string;
  recentLimit?: string;
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
    summary:
      'Encola detalles para MLAs que ya estan en Postgres pero no tienen detalle',
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
    summary:
      'Encola visitas para productos sincronizados sin visitas guardadas',
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
    description:
      'Sin staleAfterDays usa los vencimientos por grupo, igual que la pasada diaria: las recien creadas cada 1 dia, las que ya tienen visitas cada 4, y el resto cada 14. Pasando staleAfterDays se usa ese umbral plano para todas, que sirve para una recuperacion puntual.',
  })
  @ApiBody({
    schema: {
      example: {
        limit: 50000,
      },
    },
  })
  refreshVisits(@Body() body: RefreshVisitsDto) {
    return this.service.enqueueVisitsRefresh({
      staleAfterDays: body?.staleAfterDays,
      limit: body?.limit,
      // Un staleAfterDays explicito significa "quiero un umbral plano".
      tiers: body?.staleAfterDays ? null : undefined,
    });
  }

  @Get('audit/today')
  @ApiOperation({
    summary: 'Devuelve conteos de sincronizacion del dia para auditar webhooks',
  })
  syncAuditToday(@Query() query: SyncAuditQueryDto) {
    return this.service.getTodaySyncAudit({
      date: query.date,
      timezone: query.timezone,
      recentLimit: query.recentLimit ? Number(query.recentLimit) : undefined,
    });
  }

  @Get('audit/updated-count')
  @ApiOperation({
    summary: 'Devuelve cuantos productos se sincronizaron en una fecha',
  })
  async updatedCount(@Query() query: SyncAuditQueryDto) {
    const audit = await this.service.getTodaySyncAudit({
      date: query.date,
      timezone: query.timezone,
      recentLimit: 1,
    });

    return {
      date: audit.date,
      timezone: audit.timezone,
      updated_products: audit.counts.itemsSynced,
      item_rows_updated: audit.counts.itemRowsUpdated,
      details_synced: audit.counts.detailsSynced,
    };
  }

  @Post('items/scan-page')
  @ApiOperation({
    summary:
      'Trae una página de MLAs desde Meli y los guarda como pending_detail',
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

  @Get('visits/health')
  @ApiOperation({
    summary: 'Estado del recolector de visitas: ultima captura y cola',
    description:
      'Endpoint liviano para vigilar el recolector, pensado para que lo consulte un monitor cada pocos minutos. Sin api key, porque solo expone una fecha y unos contadores. Leer interrupted: true significa que hace rato que no se captura nada PERO quedan lotes en la cola, o sea que la pasada se corto a mitad de camino. Si stale es true e interrupted es false, la pasada simplemente termino.',
  })
  visitsHealth() {
    return this.service.getVisitsCollectorHealth();
  }

  @Post('items/resync')
  @UseGuards(InternalApiKeyGuard)
  @ApiSecurity('internal-api-key')
  @ApiOperation({
    summary: 'Resincroniza publicaciones ya mismo, por MLA o por SKU',
    description:
      'Trae los productos de Meli y los escribe en Postgres de forma sincronica, sin pasar por la cola. Acepta MLAs y SKUs mezclados; un SKU puede resolver a varias publicaciones. Maximo 200 valores.',
  })
  @ApiBody({
    schema: {
      example: {
        ids: ['MLA1424202023', 'B0C33CHG99'],
      },
    },
  })
  resync(@Body() body: ResyncDto) {
    return this.service.resyncByIdsOrSkus(body?.ids);
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
