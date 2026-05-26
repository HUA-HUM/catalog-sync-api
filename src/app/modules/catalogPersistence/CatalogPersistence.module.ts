import { Module } from '@nestjs/common';
import { PostgresMeliCatalogRepository } from 'src/app/drivers/repositories/postgres/catalog/PostgresMeliCatalogRepository';
import { PostgresMeliOrdersRepository } from 'src/app/drivers/repositories/postgres/orders/PostgresMeliOrdersRepository';
import { PostgresMeliVisitsRepository } from 'src/app/drivers/repositories/postgres/visits/PostgresMeliVisitsRepository';

@Module({
  providers: [
    {
      provide: 'IUpsertMeliCatalogRepository',
      useClass: PostgresMeliCatalogRepository,
    },
    {
      provide: 'IUpsertMeliOrdersRepository',
      useClass: PostgresMeliOrdersRepository,
    },
    {
      provide: 'IUpsertMeliVisitsRepository',
      useClass: PostgresMeliVisitsRepository,
    },
  ],
  exports: [
    'IUpsertMeliCatalogRepository',
    'IUpsertMeliOrdersRepository',
    'IUpsertMeliVisitsRepository',
  ],
})
export class CatalogPersistenceModule {}
