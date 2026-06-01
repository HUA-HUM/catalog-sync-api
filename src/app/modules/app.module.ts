import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullMQModule } from './BullMQ/BullMQ.module';
import { DatabaseModule } from './database/Database.module';
import { CatalogPersistenceModule } from './catalogPersistence/CatalogPersistence.module';
import { MeliWebhookModule } from './webhooks/MeliWebhook.module';
import { CatalogBackfillModule } from './catalogBackfill/CatalogBackfill.module';
import { AnalyticsModule } from './analytics/Analytics.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    CatalogPersistenceModule,
    BullMQModule,
    MeliWebhookModule,
    CatalogBackfillModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
