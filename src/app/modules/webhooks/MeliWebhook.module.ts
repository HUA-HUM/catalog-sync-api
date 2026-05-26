import { Module, OnModuleInit } from '@nestjs/common';
import { MeliWebhookController } from 'src/app/controllers/webhooks/MeliWebhook.controller';
import { startMeliWebhookWorker } from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.worker';
import { MeliWebhookService } from 'src/app/services/webhooks/MeliWebhookService';
import { CatalogPersistenceModule } from 'src/app/modules/catalogPersistence/CatalogPersistence.module';
import { MeliHttpClient } from 'src/core/drivers/mercadolibre-api/http/MeliHttpClient';
import { ProcessMeliWebhookNotification } from 'src/core/interactors/ProcessMeliWebhookNotification';

@Module({
  imports: [CatalogPersistenceModule],
  controllers: [MeliWebhookController],
  providers: [
    MeliWebhookService,
    ProcessMeliWebhookNotification,
    {
      provide: 'IMeliHttpClient',
      useClass: MeliHttpClient,
    },
  ],
})
export class MeliWebhookModule implements OnModuleInit {
  constructor(
    private readonly processNotification: ProcessMeliWebhookNotification,
  ) {}

  onModuleInit() {
    startMeliWebhookWorker(this.processNotification);
  }
}
