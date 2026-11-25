# Arquitectura y configuración

NestJS 11 sobre TypeScript, con Postgres como almacén, Redis para las colas y un proxy propio por delante de Mercado Libre.

## Capas del código

El repositorio separa `core` de `app`:

| Carpeta | Qué vive ahí |
|---|---|
| `src/core/interactors` | La lógica: qué hacer con una notificación, cómo recorrer el catálogo, cómo medir visitas. |
| `src/core/adapters` | Las interfaces de lo que esa lógica necesita: repositorios, cliente HTTP. |
| `src/core/drivers` | Las implementaciones de salida: el cliente del proxy de Mercado Libre y su manejo de errores. |
| `src/core/entitis` | Los tipos del dominio. |
| `src/app/controllers` | Los endpoints HTTP. |
| `src/app/services` | Orquestación: validan parámetros y encolan o consultan. |
| `src/app/drivers/repositories` | Implementaciones Postgres y las colas de BullMQ. |
| `src/app/modules` | El armado de dependencias de Nest. |
| `src/app/schedulers` | Los horarios de las pasadas periódicas. |
| `src/app/guards` | La validación de la clave interna. |

Los interactors reciben sus dependencias por interfaz, así que se pueden probar con stubs sin Postgres ni Redis.

## Dónde está cada cosa

| Qué busco | Archivo |
|---|---|
| Procesar una notificación del webhook | `src/core/interactors/ProcessMeliWebhookNotification.ts` |
| Carga masiva, detalles, órdenes y visitas | `src/core/interactors/ProcessCatalogBackfill.ts` |
| Escritura de publicaciones y detalle | `src/app/drivers/repositories/postgres/catalog/PostgresMeliCatalogRepository.ts` |
| Escritura de visitas | `src/app/drivers/repositories/postgres/visits/PostgresMeliVisitsRepository.ts` |
| Consultas de analytics | `src/app/drivers/repositories/postgres/analytics/PostgresAnalyticsRepository.ts` |
| Horarios de las pasadas | `src/app/schedulers/CatalogRefresh.cron.ts` |
| Cliente del proxy y manejo de errores | `src/core/drivers/mercadolibre-api/http/` |
| Retención de las colas | `src/app/drivers/repositories/processBull/queue.retention.ts` |
| Este sitio de documentación | `src/app/drivers/docs/docs-site.router.ts` |

## Tablas

| Tabla | Qué guarda |
|---|---|
| `meli_items` | Una fila por publicación: precio, stock, estado, SKU, fechas, y el payload crudo. |
| `meli_item_details` | Descripción, atributos, imágenes, variaciones, envío, etiquetas y promociones. |
| `meli_item_attributes`, `meli_item_pictures`, `meli_item_variations` | Desglose relacional de lo anterior. |
| `meli_item_visits_current` | Último valor de visitas de cada publicación. |
| `meli_item_visit_snapshots` | Historial completo de mediciones. Unos 36 millones de filas, solo altas. |
| `meli_orders`, `meli_order_items` | Órdenes y sus líneas. |
| `meli_categories` | Árbol de categorías con su camino completo. |
| `meli_webhook_events` | Registro de notificaciones recibidas. |
| `marketplace_products`, `marketplace_sync_runs` | Catálogo de otros marketplaces y sus corridas de import. |
| `analytics.product_performance` | Vista materializada que cruza catálogo, visitas y ventas. |

La vista materializada la refresca `pg_cron` cada 30 minutos, con el job `refresh-product-performance`. Es la razón por la que `performance` puede estar media hora atrás mientras `lookup` está al día.

### Dos cosas que hay que saber de la escritura

**Las publicaciones y su detalle se escriben en la misma transacción.** Un cambio que llega por webhook actualiza las dos tablas a la vez, así que el detalle no depende de la pasada semanal.

**Todos los parámetros de las consultas van casteados explícitamente.** No es estilo: en octubre de 2026 un parámetro sin tipo dentro de un `INSERT` hizo que Postgres no pudiera inferirlo, y **todas** las escrituras de publicaciones fallaron durante tres días. El patrón es `$1::text[]`, `$2::double precision`, y así.

## Colas

Todas sobre Redis, con BullMQ.

| Cola | Concurrencia | Qué procesa |
|---|---|---|
| `meli-webhooks` | 200 | Notificaciones de Mercado Libre. |
| `catalog-backfill` | 5 (hoy configurada en 1) | Carga masiva, detalles, órdenes y lotes de visitas. |
| `items-visits` | 1 | Sincronización puntual de visitas. |
| `items-details` | 1 | Sincronización puntual de detalles. |
| `update-items-details` | 1 | Actualización de detalles ya guardados. |
| `items-id` | 1 | Sincronización de identificadores. |
| `meli-categories` | 1 | Árbol de categorías. |

La concurrencia de `catalog-backfill` está en 1 a propósito: medido, con 5 procesos en paralelo se consiguen 268 mediciones de visitas por minuto y con 1 se consiguen 276. Lo único que cambia es cuánta cuota de Mercado Libre se desperdicia.

### Retención

Los jobs completados se guardan una hora; los fallidos, una semana. Antes quedaban para siempre, y eso fue lo que llenó la memoria de Redis.

| Variable | Default |
|---|---|
| `QUEUE_KEEP_COMPLETED_SECONDS` | 3600 |
| `QUEUE_KEEP_COMPLETED_COUNT` | 1000 |
| `QUEUE_KEEP_FAILED_SECONDS` | 604800 |
| `QUEUE_KEEP_FAILED_COUNT` | 5000 |

### El job que arma la pasada se adelanta en la fila

El job que selecciona qué publicaciones medir entra en la misma cola que los lotes que él mismo genera. Se encola con `lifo: true` para que salga en el próximo turno: sin eso queda detrás del backlog y el horario de las 03:00 se corre horas.

## Los horarios

Viven en el código, con `@nestjs/schedule`, no como una llave en Redis. La diferencia importa: una llave guardada en Redis desaparece sin dejar rastro si Redis la desaloja, y eso detuvo la recolección seis días. Está contado en [Visitas](visitas.md).

| Pasada | Cron | Variable |
|---|---|---|
| Visitas | `0 3 * * *` (03:00 ART) | `VISITS_REFRESH_CRON` |
| Catálogo completo | `0 2 * * 0` (domingos 02:00 ART) | `CATALOG_REFRESH_CRON` |

La zona horaria está fijada a `America/Argentina/Buenos_Aires` en el código.

> Si alguna vez el servicio corre en más de una instancia, estos horarios se disparan una vez por instancia. Hoy es un solo proceso.

## El proxy de Mercado Libre

El servicio nunca le pega directo a Mercado Libre: todo pasa por un proxy interno, `api.meli.loquieroaca.com`, que es otro servicio (`mercadolibre-api`) y es el que tiene las credenciales y maneja el token.

| Lo que usamos | Para qué |
|---|---|
| `GET /meli/products/bulk?ids=` | Releer publicaciones. Se piden de a 20. |
| `GET /meli/products/:id` | Una publicación. |
| `GET /meli/items/visits?ids=` | Visitas de varias publicaciones. Máximo 100 por pedido. |
| `GET /meli/items/:id/visits` | Visitas de una. Responde 404 cuando Mercado Libre no tiene el dato. |
| `GET /meli/products/:id/orders` | Órdenes de una publicación. |
| `GET /mercadolibre/products` | Recorrido del catálogo con cursor. |

### Reintentos

El cliente reintenta hasta 4 veces, esperando 5 segundos, 5 y 20. Con dos excepciones que importan:

- **Ante un `429`** espera lo que indica el header `Retry-After` del proxy, no su backoff fijo. Reintentar a los 5 segundos cuando el proxy pide 60 solo vuelve a chocar y gasta cuota.
- **Ante un `400` o un `404`** no reintenta: no cambian por reintentar.

El error del proxy se conserva con su status en `MeliApiError`, así que el reintento puede decidir. Antes todo se colapsaba a un `Error` genérico y el status se perdía.

## Variables de entorno

Las que no tienen default son obligatorias.

### Postgres

| Variable | Default |
|---|---|
| `POSTGRES_HOST` | `localhost` |
| `POSTGRES_PORT` | `5432` |
| `POSTGRES_DB` | `catalog_sync` |
| `POSTGRES_USER` | `catalog_sync` |
| `POSTGRES_PASSWORD` | `catalog_sync` |
| `POSTGRES_SSL` | — |
| `POSTGRES_POOL_MAX` | `10` |
| `DATABASE_URL` | — (alternativa a lo anterior) |

### Redis

| Variable | Default |
|---|---|
| `REDIS_HOST` | — |
| `REDIS_PORT` | — |
| `REDIS_USERNAME` | — |
| `REDIS_PASSWORD` | — |
| `REDIS_TLS` | — (`true` para el Redis gestionado) |

### Mercado Libre

| Variable | Default |
|---|---|
| `MELI_API_BASE_URL` | — |
| `MELI_INTERNAL_API_KEY` | — |
| `MELI_API_TIMEOUT` | `30000` |
| `MELI_BULK_CHUNK_SIZE` | `20` |
| `MELI_RATE_LIMIT_FALLBACK_SECONDS` | `60` |
| `MADRE_API_BASE_URL`, `MADRE_INTERNAL_API_KEY`, `MADRE_API_TIMEOUT` | — / — / `30000` |

### Webhook

| Variable | Default | Para qué |
|---|---|---|
| `MELI_WEBHOOK_WORKER_CONCURRENCY` | `200` | Notificaciones en paralelo. |
| `MELI_WEBHOOK_BATCH_SIZE` | `100` | Notificaciones por tanda. |
| `MELI_WEBHOOK_BATCH_WAIT_MS` | `400` | Cuánto espera una tanda incompleta. |

### Visitas

| Variable | Default | Para qué |
|---|---|---|
| `VISITS_REFRESH_ENABLED` | encendido | `false` apaga solo las visitas, sin tocar el webhook. |
| `VISITS_REFRESH_CRON` | `0 3 * * *` | Horario de la pasada. |
| `VISITS_REFRESH_CHUNK_SIZE` | `100` | Publicaciones por lote. Es el máximo del proxy. |
| `VISITS_REFRESH_STATUSES` | `active,paused,under_review` | Estados que se miden. |
| `VISITS_REFRESH_STALE_DAYS` | `0.75` | Umbral plano, solo para el uso manual. |
| `VISITS_TIER_NEW_WITHIN_DAYS` | `30` | Hasta cuándo una publicación cuenta como nueva. |
| `VISITS_TIER_NEW_STALE_DAYS` | `1` | Cada cuánto se miden las nuevas. |
| `VISITS_TIER_VISITED_STALE_DAYS` | `4` | Cada cuánto las que ya tienen visitas. |
| `VISITS_TIER_REST_STALE_DAYS` | `14` | Cada cuánto el resto. |
| `VISITS_MAX_ZERO_RATIO` | `0.9` | Proporción de ceros a partir de la cual se descarta el lote. |
| `VISITS_ZERO_GUARD_MIN_SAMPLE` | `20` | Devueltas mínimas para que esa proporción signifique algo. |
| `VISITS_HEALTH_STALE_SECONDS` | `900` | A partir de cuándo el endpoint de salud marca `stale`. |

### Otras

| Variable | Default |
|---|---|
| `PORT` | `3001` |
| `INTERNAL_API_KEY` | — (sin ella, los endpoints protegidos responden 401) |
| `CATALOG_BACKFILL_CONCURRENCY` | `5` |
| `CATALOG_REFRESH_CRON` | `0 2 * * 0` |
| `SWAGGER_PATH` | `api/docs` |
| `DOCS_SITE_ENABLED` | encendido (`false` lo apaga) |
| `DOCS_SITE_PATH` | `/docs` |
| `DOCS_SITE_USER`, `DOCS_SITE_PASSWORD` | — (con las dos, el sitio pide credenciales y publica todas las páginas) |

## Este sitio de documentación

El sitio sirve los markdown del repositorio con Docsify, leyéndolos en cada pedido: **un `git pull` alcanza para publicar un cambio de texto**, sin reiniciar.

Tres reglas que conviene respetar al editarlo:

1. **Las rutas copian la estructura del repositorio**: el README en la raíz y el resto en `docs/`. Eso es lo que hace que los enlaces relativos entre los archivos funcionen igual en el sitio y en GitHub.
2. **Solo se sirve una lista fija de archivos**, declarada en `DOCS_PAGES`. Nada más del repositorio es accesible, ni con `..` en la URL. Hay un test que lo verifica.
3. **Los títulos no pueden empezar con un número.** Docsify les antepone un `_` al identificador y los enlaces funcionan en GitHub pero no en el sitio.

La página de operación está marcada como restringida: con el sitio abierto se reemplaza por un aviso, y solo se publica cuando hay usuario y clave.

## Tests

```bash
npm test                # jest
npm run lint            # eslint con --fix
npx tsc --noEmit        # chequeo de tipos
npm run docs:preview    # el sitio en http://localhost:4310/docs
```

## Limitaciones conocidas

- **El techo de visitas es de Mercado Libre**, unas 300 mediciones por minuto, y no se puede subir desde acá. Está explicado en [Visitas](visitas.md).
- **El lint tiene errores preexistentes** en los `case` de un `switch` y en un `unknown | null`. No vienen de cambios recientes.
- **Redis está con política `allkeys-lru`.** Mientras siga así puede borrar llaves solo bajo presión de memoria, que es exactamente lo que detuvo la recolección en noviembre. Debería ser `noeviction`.
- **La vista materializada se refresca cada 30 minutos**, así que `performance` no sirve para precio ni estado al día.
- **Los logs no tienen marca de tiempo propia**, se apoyan en la de PM2. Eso complicó dos diagnósticos.
