import { Module } from '@nestjs/common';
import { MarketplaceProductsController } from 'src/app/controllers/marketplace/MarketplaceProducts.controller';
import { MarketplaceSyncRunsController } from 'src/app/controllers/marketplace/MarketplaceSyncRuns.controller';
import { PostgresMarketplaceProductsRepository } from 'src/app/drivers/repositories/postgres/marketplace/PostgresMarketplaceProductsRepository';
import { PostgresMarketplaceSyncRunsRepository } from 'src/app/drivers/repositories/postgres/marketplace/PostgresMarketplaceSyncRunsRepository';
import { MarketplaceProductsService } from 'src/app/services/marketplace/MarketplaceProductsService';
import { MarketplaceSyncRunsService } from 'src/app/services/marketplace/MarketplaceSyncRunsService';

@Module({
  controllers: [MarketplaceProductsController, MarketplaceSyncRunsController],
  providers: [
    MarketplaceProductsService,
    MarketplaceSyncRunsService,
    {
      provide: 'IMarketplaceProductsRepository',
      useClass: PostgresMarketplaceProductsRepository,
    },
    {
      provide: 'IMarketplaceSyncRunsRepository',
      useClass: PostgresMarketplaceSyncRunsRepository,
    },
  ],
})
export class MarketplaceModule {}
