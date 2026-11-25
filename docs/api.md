# Referencia de la API

Base de producción: `http://104.131.117.64:3001`

Para probar desde el navegador está Swagger en [`/api/docs`](/api/docs), con el botón **Authorize** para cargar la clave.

## Autenticación

Los endpoints marcados con 🔒 piden este header:

```
x-internal-api-key: <INTERNAL_API_KEY>
```

| Respuesta | Cuándo |
|---|---|
| `401 Invalid api key` | Falta el header o la clave no coincide. |
| `401 INTERNAL_API_KEY is not configured` | El servicio arrancó sin la variable configurada. |

La protección se aplica ruta por ruta, no globalmente: se fue agregando sin romper consumidores existentes. Los endpoints sin 🔒 están abiertos.

## Errores de validación

Todos los parámetros inválidos devuelven `400` con el campo en el mensaje. Los mensajes salen tal cual del código:

| Mensaje | Cuándo |
|---|---|
| `ids is required` | Falta un parámetro obligatorio de identificadores. |
| `ids or skus is required` | En `visit-history` hay que mandar al menos uno de los dos. |
| `ids allows at most 200 values` | Se pasó el máximo del endpoint de resincronización. |
| `ids max length is 100` | Se pasó el máximo de `lookup`. |
| `list filters allow at most 100 values` | Un filtro de lista recibió más de 100 valores. |
| `<campo> must be a number` · `must be an integer` · `must be 0 or greater` | El valor no es del tipo esperado. |
| `<campo> is out of range` | El valor está fuera del mínimo o el máximo del endpoint. |
| `<campo> must be a valid ISO date` | Una fecha no se pudo interpretar. |
| `date must use YYYY-MM-DD format` | Formato de fecha de la auditoría. |
| `granularity must be day, week or month` | Granularidad inválida en el historial de categorías. |
| `sortOrder must be asc or desc` | Orden inválido. |
| `id must be a UUID` | Identificador de marketplace mal formado. |

## Publicaciones

### Datos actuales de uno o varios MLA

🔒 `GET /analytics/products/lookup`

Lee la tabla de publicaciones directamente, así que devuelve precio y estado actualizados.

| Parámetro | | Detalle |
|---|---|---|
| `ids` | obligatorio | Uno o varios MLA separados por coma. Máximo 100. |

```bash
curl -s -H "x-internal-api-key: $INTERNAL_API_KEY" \
  "$BASE/analytics/products/lookup?ids=MLA1424202023,MLA1538120729"
```

```json
{
  "requested": 2,
  "found": 2,
  "not_found": [],
  "products": [
    {
      "itemId": "MLA1424202023",
      "sku": "B0C33CHG99",
      "categoryId": "MLA412445",
      "listingTypeId": "gold_special",
      "price": 45900,
      "last_updated": "2026-11-24T14:21:05.000Z",
      "status": "active"
    }
  ]
}
```

`not_found` trae los MLA que no están en la base.

### Ficha completa por SKU

🔒 `GET /analytics/products/by-sku`

Todas las publicaciones de un SKU, con descripción, atributos e imágenes. Un SKU puede tener varias publicaciones: el consumidor elige según `listingTypeId` y `status`.

| Parámetro | | Detalle |
|---|---|---|
| `sellerId` | obligatorio | Vendedor. Es obligatorio porque es lo que permite usar los índices por SKU. Hoy: `1757836744`. |
| `sku` | obligatorio | SKU exacto. No hace match parcial ni ignora mayúsculas. |

```bash
curl -s -H "x-internal-api-key: $INTERNAL_API_KEY" \
  "$BASE/analytics/products/by-sku?sellerId=1757836744&sku=B0C33CHG99"
```

Si la publicación no tiene el detalle sincronizado, `description`, `attributes` y `pictures` vienen en `null`. El match usa el SKU del vendedor y cae al SKU alternativo solo cuando el primero es nulo.

### Performance cruzada

`GET /analytics/products/performance`

Lee la vista materializada `analytics.product_performance`, que cruza catálogo, visitas y ventas. Acepta más de 40 filtros: por marca, categoría, dominio, tipo de publicación, estado, rangos de precio, stock, visitas, ventas, facturación, conversión y fechas.

| Parámetro | Default | Detalle |
|---|---|---|
| `limit` | 100 | Entre 1 y 1000. |
| `offset` | 0 | |
| `search` | | Busca por MLA, título, SKU, marca, categoría o dominio. |
| `sortBy` | | Uno de los campos de la vista. |
| `sortOrder` | | `asc` o `desc`. |

La lista completa de filtros está en Swagger, que la genera del código.

> La vista es materializada: la refresca `pg_cron` cada 30 minutos. Para precio y estado al día hay que usar `lookup`, que lee la tabla.

## Visitas

### Historial de mediciones

🔒 `GET /analytics/products/visit-history`

Serie cruda: una fila por publicación y fecha de medición. Antes de usarla conviene leer [Visitas](visitas.md), porque **el número no se puede restar entre dos fechas**.

| Parámetro | Default | Detalle |
|---|---|---|
| `ids` | | MLA separados por coma. Máximo 100. |
| `skus` | | SKU separados por coma. Máximo 100. Resuelve a todas las publicaciones del SKU. |
| `from` | | Medición desde, inclusive. ISO. |
| `to` | | Medición hasta, **exclusive**. ISO. |
| `limit` | 1000 | Máximo 20000. |
| `offset` | 0 | |

Hay que mandar `ids` o `skus`; se pueden combinar. Si no viene ninguno: `400 ids or skus is required`.

```json
{
  "requested_ids": 1, "requested_skus": 0, "items_found": 1,
  "not_found_ids": [], "not_found_skus": [],
  "from": "2026-09-01", "to": null,
  "count": 10, "limit": 1000, "offset": 0, "has_next": false,
  "snapshots": [
    { "itemId": "MLA1538120729", "sku": "B002A6FXZE", "visits": 143, "capturedAt": "2026-09-17T17:24:03.094Z" }
  ]
}
```

Las filas vienen ordenadas por publicación y después por fecha. Para paginar, subir `offset` mientras `has_next` sea `true`.

### Valor actual de muchas publicaciones

🔒 `POST /analytics/visits/bulk`

Es POST y no GET porque un listado grande no entra en la query string.

| Campo | | Detalle |
|---|---|---|
| `ids` | obligatorio | Array de MLA. Máximo 10000. También acepta un string separado por comas. |

```bash
curl -s -X POST "$BASE/analytics/visits/bulk" \
  -H "x-internal-api-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids":["MLA1424202023","MLA1538120729"]}'
```

`capturedAt` importa: no es "ahora", es cuándo se midió ese número por última vez.

### Recorrer todo el catálogo

🔒 `GET /analytics/visits/catalog`

Paginado por cursor sobre el MLA, no por offset, así que el tiempo de respuesta no se degrada al avanzar.

| Parámetro | Default | Detalle |
|---|---|---|
| `limit` | 1000 | Máximo 10000. |
| `afterItemId` | | El `next_cursor` de la respuesta anterior. Vacío para la primera página. |

Seguir pidiendo mientras `has_next` sea `true`, pasando `next_cursor` como `afterItemId`.

### Más visitadas y conversión

`GET /analytics/visits/top-products` · parámetro `limit`.

`GET /analytics/visits/conversion-by-category` · parámetros `from` y `to`.

## Catálogo

| Endpoint | Qué devuelve |
|---|---|
| `GET /analytics/catalog/summary` | Totales por estado, stock, precio promedio, valor del stock, cantidad de categorías y marcas. |
| `GET /analytics/catalog/table-freshness` | Qué tan al día está cada tabla. Parámetro `staleAfterHours`, default 24, entre 1 y 8760. |
| `GET /analytics/catalog/age` | Distribución de publicaciones por fecha de creación. |
| `GET /analytics/catalog/missing-data` | Auditoría de publicaciones con datos faltantes. |

## Categorías

| Endpoint | Parámetros |
|---|---|
| `GET /analytics/categories` | `limit` (1000), `offset`, `search` |
| `GET /analytics/categories/tree` | — |
| `GET /analytics/categories/performance` | `from`, `to`, `limit` (100), `offset` |
| `GET /analytics/categories/history` | `from`, `to`, `granularity` (`day`, `week` o `month`), `limit` (25), `offset` |
| `GET /analytics/categories/:categoryId/publications` | `domainId` opcional |
| `GET /analytics/categories/:categoryId/visits` | `domainId` opcional |
| `GET /analytics/categories/:categoryId/revenue` | `domainId` opcional |

## Ventas y marcas

| Endpoint | Parámetros |
|---|---|
| `GET /analytics/orders/summary` | `from`, `to` |
| `GET /analytics/orders/by-sku` | `from`, `to` |
| `GET /analytics/brands/summary` | `from`, `to` |
| `GET /analytics/brands/orders` | `from`, `to` |

## Sincronización

Endpoints de mantenimiento, bajo `/internal/catalog-backfill`. Casi todos encolan trabajo y contestan enseguida con el identificador de la corrida; el avance se mira en Bull Board.

### Estado del recolector de visitas

`GET /internal/catalog-backfill/visits/health`

Sin clave, pensado para que lo consulte un monitor cada pocos minutos.

```json
{
  "last_capture_at": "2026-11-25T18:02:43.761Z",
  "seconds_since_last_capture": 4,
  "stale": false,
  "interrupted": false,
  "queue": { "waiting": 5543, "active": 1, "failed": 0 },
  "stale_after_seconds": 900
}
```

| Campo | Cómo leerlo |
|---|---|
| `stale` | Hace más de `stale_after_seconds` que no se mide nada. |
| `interrupted` | **El importante.** Hace rato que no se mide **pero quedan lotes en la cola**: la pasada se cortó a mitad de camino. |
| `stale: true` con `interrupted: false` | La pasada simplemente terminó. |

### Resincronizar ya mismo, por MLA o SKU

🔒 `POST /internal/catalog-backfill/items/resync`

Trae las publicaciones de Mercado Libre y las escribe en Postgres de forma sincrónica, sin pasar por la cola. Sirve para adelantar un cambio encolado o recuperar una publicación que quedó desactualizada.

| Campo | | Detalle |
|---|---|---|
| `ids` | obligatorio | MLA y SKU mezclados en la misma lista. Lo que matchea `MLA` más dígitos se toma como MLA, el resto como SKU. Máximo 200. |

```bash
curl -s -X POST "$BASE/internal/catalog-backfill/items/resync" \
  -H "x-internal-api-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"ids":["MLA1424202023","B0C33CHG99"]}'
```

`resolved_items` puede ser mayor que `requested` cuando un SKU resuelve a varias publicaciones. Es sincrónico: con 200 valores puede tardar varios segundos. El MLA va sin guión.

### Pasada de visitas a pedido

`POST /internal/catalog-backfill/visits/refresh`

Sin `staleAfterDays` usa los vencimientos por grupo, igual que la pasada diaria. Pasando `staleAfterDays` usa ese umbral plano para todas, que sirve para una recuperación puntual.

| Campo | Default | Detalle |
|---|---|---|
| `staleAfterDays` | por grupos | Umbral plano, en días. Acepta fracciones. Tiene que ser mayor que 0. |
| `limit` | sin límite | Cuántas publicaciones seleccionar como máximo. |

### Resto de la sincronización

| Endpoint | Qué hace |
|---|---|
| `POST /internal/catalog-backfill/start` | Carga masiva completa: recorre el catálogo, trae detalles y opcionalmente órdenes y visitas. Campos: `limit` (1-100), `detailChunkSize` (1-20), `maxPages`, `maxItems`, `includeOrders`, `includeVisits`. |
| `POST /internal/catalog-backfill/details/resume-missing` | Encola el detalle de las publicaciones que no lo tienen. |
| `POST /internal/catalog-backfill/orders/resume` | Encola órdenes de publicaciones con ventas. `orderPageLimit` entre 1 y 100. |
| `POST /internal/catalog-backfill/visits/resume-missing` | Encola visitas de las publicaciones que nunca se midieron. |
| `POST /internal/catalog-backfill/items/scan-page` | Trae una página del catálogo de Mercado Libre, con cursor. `limit` entre 1 y 100. |
| `POST /internal/catalog-backfill/items/details-by-ids` | Trae el detalle de los MLA indicados y lo guarda. |
| `GET /internal/catalog-backfill/audit/today` | Conteos del día para auditar que el webhook está escribiendo. Parámetros `date` (`YYYY-MM-DD`), `timezone`, `recentLimit` (1-500). |
| `GET /internal/catalog-backfill/audit/updated-count` | Cuántas publicaciones se sincronizaron en una fecha. |

### Sincronizaciones puntuales

| Endpoint | Qué hace |
|---|---|
| `POST /internal/meli-categories/sync` | Resincroniza el árbol de categorías. |
| `POST /internal/items-id/sync` | Sincroniza identificadores de publicaciones. |
| `POST /internal/items-details/sync` | Sincroniza detalles. |
| `POST /internal/items-details/update` | Actualiza detalles ya guardados. |
| `POST /internal/items-visits/sync` | Sincroniza visitas. |

## Otros marketplaces

Todos estos endpoints piden clave. El parámetro `marketplace` es obligatorio en los listados; hoy el valor en uso es `fravega`.

### Productos

| Endpoint | Qué hace |
|---|---|
| 🔒 `POST /marketplace-products/bulk` | Guarda un lote de productos, creando o actualizando por `(marketplace, externalId)`. `items` no puede venir vacío. |
| 🔒 `GET /marketplace-products` | Lista con resumen por estado. Parámetros: `marketplace` (obligatorio), `limit` (100), `offset`, `sku`, `status`. |
| 🔒 `GET /marketplace-products/exists` | Si un SKU ya está publicado. Parámetros `marketplace` y `sellerSku`, los dos obligatorios. |
| 🔒 `GET /marketplace-products/:id` | Por identificador. `404 Marketplace product <id> not found` si no existe. |
| 🔒 `POST /marketplace-products` | Crea uno. |
| 🔒 `PUT /marketplace-products/:id` | Actualiza los campos enviados. `400 body must have at least one change` si el body viene vacío. |
| 🔒 `DELETE /marketplace-products/:id` | Borra uno. |

Forma de un producto:

```json
{
  "externalId": "155562",
  "sellerSku": "B09S3XJC81",
  "marketplaceSku": "MKT0001LQA",
  "price": 596398.95,
  "stock": 5,
  "status": "ACTIVE",
  "raw": { "id": "155562", "title": "Producto de ejemplo" }
}
```

### Corridas de import

| Endpoint | Qué hace |
|---|---|
| 🔒 `POST /marketplace-sync-runs` | Abre una corrida. |
| 🔒 `POST /marketplace-sync-runs/:id/progress` | Suma avance. |
| 🔒 `POST /marketplace-sync-runs/:id/finish` | Cierra con el estado indicado. |
| 🔒 `POST /marketplace-sync-runs/:id/fail` | Marca como `FAILED`. |
| 🔒 `GET /marketplace-sync-runs` | Lista, la más nueva primero. Parámetros: `marketplace` (obligatorio), `limit` (20), `offset`. |

`404 Marketplace sync run <id> not found` si el identificador no existe.

## Webhook

`POST /webhooks/meli`

Lo llama Mercado Libre. Responde `200` siempre que el cuerpo traiga `topic` y `resource`; encola la notificación y contesta sin esperar a procesarla.

```json
{ "status": "queued", "job_id": "meli-webhook-items-..." }
```

Si falta alguno de los dos campos, `400 topic is required` o `400 resource is required`.

No tiene clave: es un endpoint público porque lo llama Mercado Libre.
