import { Module, OnModuleInit } from '@nestjs/common';
import { CatalogBackfillController } from 'src/app/controllers/catalogBackfill/CatalogBackfill.controller';
import { startCatalogBackfillWorker } from 'src/app/drivers/repositories/processBull/catalogBackfill/CatalogBackfill.worker';
import { CatalogPersistenceModule } from 'src/app/modules/catalogPersistence/CatalogPersistence.module';
import { CatalogBackfillService } from 'src/app/services/catalogBackfill/CatalogBackfillService';
import { MeliHttpClient } from 'src/core/drivers/mercadolibre-api/http/MeliHttpClient';
import { ProcessCatalogBackfill } from 'src/core/interactors/ProcessCatalogBackfill';

@Module({
  imports: [CatalogPersistenceModule],
  controllers: [CatalogBackfillController],
  providers: [
    CatalogBackfillService,
    ProcessCatalogBackfill,
    {
      provide: 'IMeliHttpClient',
      useClass: MeliHttpClient,
    },
  ],
})
export class CatalogBackfillModule implements OnModuleInit {
  constructor(
    private readonly processCatalogBackfill: ProcessCatalogBackfill,
    private readonly catalogBackfillService: CatalogBackfillService,
  ) {}

  async onModuleInit() {
    startCatalogBackfillWorker(this.processCatalogBackfill);
    await this.catalogBackfillService.ensureRecurringVisitsRefresh();
  }
}
