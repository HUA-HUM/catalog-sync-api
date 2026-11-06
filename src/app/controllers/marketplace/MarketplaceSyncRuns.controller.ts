import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { InternalApiKeyGuard } from 'src/app/guards/InternalApiKey.guard';
import { MarketplaceSyncRunsService } from 'src/app/services/marketplace/MarketplaceSyncRunsService';
import type { MarketplaceSyncRunProgressBody } from 'src/app/services/marketplace/MarketplaceSyncRunsService';

@ApiTags('Marketplace - Corridas de import')
@ApiSecurity('internal-api-key')
@UseGuards(InternalApiKeyGuard)
@Controller('marketplace-sync-runs')
export class MarketplaceSyncRunsController {
  constructor(private readonly service: MarketplaceSyncRunsService) {}

  @Post()
  @ApiOperation({
    summary: 'Abre una corrida de import',
    description:
      'Si el marketplace tiene otra en RUNNING, la marca FAILED: solo puede correr un import por vez, asi que quedo colgada.',
  })
  @ApiBody({ schema: { example: { marketplace: 'fravega' } } })
  start(@Body() body?: { marketplace?: unknown }) {
    return this.service.start(body?.marketplace);
  }

  @Post(':id/progress')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Suma avance a una corrida' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ schema: { example: { batches: 1, items: 100, failed: 0 } } })
  reportProgress(
    @Param('id') id: string,
    @Body() body?: MarketplaceSyncRunProgressBody,
  ) {
    return this.service.reportProgress(id, body);
  }

  @Post(':id/finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cierra una corrida con el estado indicado' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ schema: { example: { status: 'SUCCESS' } } })
  finish(@Param('id') id: string, @Body() body?: { status?: unknown }) {
    return this.service.finish(id, body?.status);
  }

  @Post(':id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca una corrida como FAILED' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({
    schema: { example: { errorMessage: 'Timeout consultando Fravega' } },
  })
  fail(@Param('id') id: string, @Body() body?: { errorMessage?: unknown }) {
    return this.service.fail(id, body?.errorMessage);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista las corridas de un marketplace, la mas nueva primero',
  })
  @ApiQuery({ name: 'marketplace', required: true, example: 'fravega' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  list(
    @Query('marketplace') marketplace?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list({ marketplace, limit, offset });
  }
}
