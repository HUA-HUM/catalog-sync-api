import { Module, OnModuleInit } from '@nestjs/common';
import { SyncMeliCategoriesController } from 'src/app/controllers/categories/SyncMeliCategories.controller';
import { MeliCategoriesService } from 'src/app/services/categories/MeliCategoriesService';
import { SyncMeliCategories } from 'src/core/interactors/SyncMeliCategories';
import { GetCategoriesRepository } from 'src/core/drivers/mercadolibre-api/categories/GetCategoriesRepository';
import { SaveMeliCategoriesRepository } from 'src/core/drivers/madre-api/categories/SaveMeliCategoriesRepository';
import { SyncStatesRepository } from 'src/core/drivers/madre-api/syncStates/SyncStatesRepository';
import { MeliHttpClient } from 'src/core/drivers/mercadolibre-api/http/MeliHttpClient';
import { MadreHttpClient } from 'src/core/drivers/madre-api/http/MadreHttpClient';
import { startMeliCategoriesSyncWorker } from 'src/app/drivers/repositories/processBull/categories/MeliCategoriesSync.worker';
import { PostgresMeliCategoriesRepository } from 'src/app/drivers/repositories/postgres/categories/PostgresMeliCategoriesRepository';

@Module({
  controllers: [SyncMeliCategoriesController],
  providers: [
    MeliCategoriesService,
    SyncMeliCategories,

    {
      provide: 'IGetCategoriesRepository',
      useClass: GetCategoriesRepository,
    },
    {
      provide: 'ISaveMeliCategoriesRepository',
      useClass: SaveMeliCategoriesRepository,
    },
    {
      provide: 'IUpsertMeliCategoriesRepository',
      useClass: PostgresMeliCategoriesRepository,
    },
    {
      provide: 'ISyncStatesRepository',
      useClass: SyncStatesRepository,
    },

    {
      provide: 'IMeliHttpClient',
      useClass: MeliHttpClient,
    },
    {
      provide: 'IMadreHttpClient',
      useClass: MadreHttpClient,
    },
  ],
})
export class MeliCategoriesModule implements OnModuleInit {
  constructor(private readonly syncMeliCategories: SyncMeliCategories) {}

  onModuleInit() {
    startMeliCategoriesSyncWorker(this.syncMeliCategories);
  }
}
