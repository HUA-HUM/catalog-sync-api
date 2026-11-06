import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
import { MarketplaceProductsService } from 'src/app/services/marketplace/MarketplaceProductsService';
import type {
  BulkMarketplaceProductsBody,
  CreateMarketplaceProductBody,
  MarketplaceProductBody,
} from 'src/app/services/marketplace/MarketplaceProductsService';

const PRODUCT_EXAMPLE = {
  externalId: '155562',
  sellerSku: 'B09S3XJC81',
  marketplaceSku: 'MKT0001LQA',
  price: 596398.95,
  stock: 5,
  status: 'ACTIVE',
  raw: { id: '155562', title: 'Producto de ejemplo' },
};

@ApiTags('Marketplace - Productos')
@ApiSecurity('internal-api-key')
@UseGuards(InternalApiKeyGuard)
@Controller('marketplace-products')
export class MarketplaceProductsController {
  constructor(private readonly service: MarketplaceProductsService) {}

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guarda productos de un marketplace, creando o actualizando',
    description:
      'Identifica cada producto por marketplace + externalId. Maximo 1000 productos por llamada. Si uno es invalido, no se guarda ninguno. Requiere el header x-internal-api-key.',
  })
  @ApiBody({
    schema: {
      example: { marketplace: 'fravega', items: [PRODUCT_EXAMPLE] },
    },
  })
  bulkUpsert(@Body() body: BulkMarketplaceProductsBody) {
    return this.service.bulkUpsert(body);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista los productos de un marketplace, con resumen por estado',
  })
  @ApiQuery({ name: 'marketplace', required: true, example: 'fravega' })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({
    name: 'sku',
    required: false,
    description: 'Coincidencia parcial sobre seller_sku',
  })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  list(
    @Query('marketplace') marketplace?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sku') sku?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list({ marketplace, limit, offset, sku, status });
  }

  @Get('exists')
  @ApiOperation({
    summary: 'Indica si un SKU ya esta publicado en un marketplace',
    description: 'Busca por coincidencia exacta de seller_sku.',
  })
  @ApiQuery({ name: 'marketplace', required: true, example: 'fravega' })
  @ApiQuery({ name: 'sellerSku', required: true, example: 'B09S3XJC81' })
  exists(
    @Query('marketplace') marketplace?: string,
    @Query('sellerSku') sellerSku?: string,
  ) {
    return this.service.exists(marketplace, sellerSku);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un producto por id' })
  @ApiParam({ name: 'id', format: 'uuid' })
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Crea un producto',
    description: 'Responde 409 si ya existe ese marketplace + externalId.',
  })
  @ApiBody({
    schema: { example: { marketplace: 'fravega', ...PRODUCT_EXAMPLE } },
  })
  create(@Body() body: CreateMarketplaceProductBody) {
    return this.service.create(body);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Actualiza los campos enviados de un producto',
    description:
      'marketplace y externalId identifican al producto: no cambian.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ schema: { example: { price: 610000, stock: 3 } } })
  update(@Param('id') id: string, @Body() body: MarketplaceProductBody) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borra un producto' })
  @ApiParam({ name: 'id', format: 'uuid' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
