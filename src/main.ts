import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app/modules/app.module';
import { setupBullBoard } from './app/bull-board.setup';
import { createDocsSiteRouter } from './app/drivers/docs/docs-site.router';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  // Swagger pasa de /docs a /api/docs porque /docs es ahora el sitio de
  // documentacion, igual que en invoice.api. Es un cambio de URL: quien tenga
  // guardado /docs para probar endpoints tiene que actualizarlo.
  const swaggerPath = readOptional('SWAGGER_PATH') ?? 'api/docs';
  SwaggerModule.setup(swaggerPath, app, document);

  // ─────────────────────────────
  // Bull Board
  // ─────────────────────────────
  setupBullBoard(app);

  // ─────────────────────────────
  // Sitio de documentacion
  // ─────────────────────────────
  if ((readOptional('DOCS_SITE_ENABLED') ?? 'true') !== 'false') {
    const docsPath = readOptional('DOCS_SITE_PATH') ?? '/docs';
    const username = readOptional('DOCS_SITE_USER');
    const password = readOptional('DOCS_SITE_PASSWORD');

    // Con usuario y clave el sitio los pide y publica todas las paginas; sin
    // ellos queda abierto y deja afuera la pagina de operacion. El markdown se
    // lee del checkout del repositorio desde donde corre el servicio.
    app.use(
      docsPath,
      createDocsSiteRouter({
        basePath: docsPath,
        rootDirectory: process.cwd(),
        credentials:
          username !== undefined && password !== undefined
            ? { username, password }
            : undefined,
      }),
    );
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`http://localhost:${port}`);
}

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

void bootstrap();
