import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app/modules/app.module';
import { setupBullBoard } from './app/bull-board.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Un lote de productos de marketplace supera el limite de 100kb de Express
  app.useBodyParser('json', { limit: '5mb' });

  // ─────────────────────────────
  // Swagger
  // ─────────────────────────────
  const config = new DocumentBuilder()
    .setTitle('Catalog Sync API')
    .setDescription(
      'API encargada de sincronizar publicaciones, métricas y datos de MercadoLibre',
    )
    .setVersion('1.0.0')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-internal-api-key',
        in: 'header',
      },
      'internal-api-key',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // ─────────────────────────────
  // Bull Board
  // ─────────────────────────────
  setupBullBoard(app);

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`http://localhost:${port}`);
}

bootstrap();
