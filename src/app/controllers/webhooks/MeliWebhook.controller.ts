import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MeliWebhookService } from 'src/app/services/webhooks/MeliWebhookService';

@ApiTags('MercadoLibre Webhooks')
@Controller('webhooks/meli')
export class MeliWebhookController {
  constructor(private readonly service: MeliWebhookService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recibe notificaciones de MercadoLibre y las encola',
  })
  async receive(@Body() body: Record<string, unknown>) {
    return this.service.enqueueNotification(body);
  }
}
