import { Module } from '@nestjs/common';
import { AnalyticsBrandsController } from 'src/app/controllers/analytics/AnalyticsBrands.controller';
import { AnalyticsCatalogController } from 'src/app/controllers/analytics/AnalyticsCatalog.controller';
import { AnalyticsCategoriesController } from 'src/app/controllers/analytics/AnalyticsCategories.controller';
import { AnalyticsOrdersController } from 'src/app/controllers/analytics/AnalyticsOrders.controller';
import { AnalyticsVisitsController } from 'src/app/controllers/analytics/AnalyticsVisits.controller';
import { PostgresAnalyticsRepository } from 'src/app/drivers/repositories/postgres/analytics/PostgresAnalyticsRepository';
import { AnalyticsService } from 'src/app/services/analytics/AnalyticsService';

@Module({
  controllers: [
    AnalyticsCatalogController,
    AnalyticsCategoriesController,
    AnalyticsOrdersController,
    AnalyticsBrandsController,
    AnalyticsVisitsController,
  ],
  providers: [
    AnalyticsService,
    {
      provide: 'IAnalyticsRepository',
      useClass: PostgresAnalyticsRepository,
    },
  ],
})
export class AnalyticsModule {}
