# Guía funcional

Qué guarda el servicio de cada publicación, cómo se enteran los cambios y cada cuánto se refresca cada cosa.

Hay una regla que conviene tener presente desde el principio: **el servicio es una copia de lectura**. No publica, no edita precios ni cambia stock en Mercado Libre. Solo lee y guarda.

## El catálogo

El servicio sigue un único vendedor de Mercado Libre: el de Tienda Lo Quiero Acá (`1757836744`). Hoy tiene guardadas unos 2,2 millones de publicaciones:

| Estado | Publicaciones |
|---|---|
| Activas | 1.182.347 |
| Cerradas | 788.166 |
| Inactivas | 97.690 |
| En revisión | 92.510 |
| Pausadas | 85.715 |

> Las cerradas se conservan a propósito. El servicio nunca borra una publicación: si en Mercado Libre se dio de baja, acá queda con su estado `closed`. Por eso el total guardado es mayor que el catálogo vivo, y por eso **cualquier consulta que deba mostrar solo lo vigente tiene que filtrar por estado**.

### Qué se guarda de cada publicación

| Grupo | Datos |
|---|---|
| Identificación | MLA, SKU del vendedor, SKU alternativo, título, marca, permalink |
| Precio | Precio de venta, precio base, precio tachado, moneda |
| Disponibilidad | Stock, cantidad disponible, cantidad vendida, estado |
| Clasificación | Categoría, dominio, tipo de publicación, condición |
| Fechas | Creación, última modificación en Mercado Libre, última sincronización nuestra |
| Detalle | Descripción, atributos, imágenes, variaciones, envío, etiquetas |
| Promociones | Identificadores de las promociones en las que participa |

Hay dos campos propios que no vienen de Mercado Libre y sirven para detectar cambios de precio: **cuándo cambió el precio por última vez** y **cuándo cambió el precio tachado por última vez**. Se actualizan solo cuando el valor nuevo es distinto del guardado, así que sirven para responder "¿cuándo entró en promoción?".

## Cómo llegan los cambios

Mercado Libre avisa por webhook cada vez que algo cambia en una publicación. El servicio recibe el aviso, lo encola y contesta enseguida; el trabajo real pasa después.

De todos los avisos que manda Mercado Libre, el servicio actúa sobre tres:

| Aviso | Cuándo llega |
|---|---|
| `items` | Cambió algo de la publicación: precio, stock, título, estado. |
| `items_prices` | Cambió el precio de lista. |
| `public_offers` | La publicación entró o salió de una promoción. |

El resto se registra y se descarta. `price_suggestion` y `public_candidates`, por ejemplo, son sugerencias e invitaciones de Mercado Libre, no cambios efectivos.

Los avisos no se procesan de a uno: el servicio los **junta de a 100** (o espera 400 milisegundos, lo que pase primero) y relee esas publicaciones en una sola tanda. Eso reduce muchísimo la cantidad de consultas a Mercado Libre.

Cuando una publicación releída tiene ventas, el servicio encola además la búsqueda de sus órdenes.

### Cuánto tarda en verse un cambio

En condiciones normales, **minutos**. Lo que puede estirarlo es la cola: si Mercado Libre manda muchos avisos de golpe, se forma una fila y el cambio entra cuando le toca. El estado de la cola se ve en Bull Board, en `/admin/queues`.

## Las pasadas periódicas

Además del webhook hay dos pasadas programadas:

| Pasada | Cuándo | Qué hace |
|---|---|---|
| Visitas | Todos los días a las 03:00 | Mide las visitas de las publicaciones que ya vencieron, por grupos de prioridad. |
| Catálogo completo | Domingos a las 02:00 | Recorre todas las publicaciones del vendedor y relee su detalle. |

La pasada semanal existe para tapar huecos: si un aviso del webhook se perdió, esa publicación igual se corrige cuando pasa el recorrido completo.

Las visitas tienen reglas propias y bastante sutileza. Están explicadas aparte, en [Visitas](visitas.md).

## Las ventas

El servicio guarda las órdenes de las publicaciones que vendieron, con sus unidades y precios unitarios. Hoy hay 16.421 órdenes, desde mayo de 2025.

Las órdenes no llegan por webhook: se buscan cuando el servicio detecta que una publicación tiene ventas, y en las pasadas de carga masiva. Sirven sobre todo para cruzarlas con visitas y stock, y responder preguntas de conversión: cuántas visitas hicieron falta para vender una unidad.

## Las categorías

Se guardan las 12.374 categorías de Mercado Libre con su nombre y su camino completo (`Hogar > Cocina > ...`). Se sincronizan a pedido, no automáticamente, porque el árbol de categorías cambia muy poco.

Sirven para que las consultas del catálogo puedan mostrar el nombre de la categoría en lugar del código, y para agrupar por rubro.

## Otros marketplaces

Aparte del catálogo de Mercado Libre, el servicio guarda el catálogo que otros procesos publican en otros marketplaces. Hoy hay uno activo: **Frávega**, con 33.470 productos.

Esto funciona distinto: el servicio no sale a buscar nada. Son otros procesos los que le avisan qué publicaron, y el servicio lo guarda y lleva el registro de cada corrida de import:

| Estado de la corrida | Qué significa |
|---|---|
| `RUNNING` | La corrida está en curso. |
| `SUCCESS` | Terminó y procesó todo. |
| `PARTIAL` | Terminó pero algunos productos fallaron. |
| `FAILED` | Se cortó. |

El vínculo entre los dos mundos es el **SKU del vendedor**: el mismo SKU identifica al producto en Mercado Libre y en Frávega, así que se puede responder "¿este producto ya está publicado en Frávega?".

## Qué el servicio no hace

Vale aclararlo porque son preguntas que aparecen seguido:

- **No publica ni edita nada en Mercado Libre.** Es solo lectura.
- **No borra publicaciones.** Las dadas de baja quedan con estado `closed`.
- **No decide precios ni promociones.** Registra los cambios, no los provoca.
- **No es la fuente de verdad.** La fuente es Mercado Libre; esto es una copia que puede estar minutos atrás, o más si la cola está cargada.
- **No calcula visitas de un período.** Guarda las mediciones crudas; el motivo está en [Visitas](visitas.md).

## Las consultas disponibles

Resumidas por lo que responden. El detalle de parámetros está en la [referencia de la API](api.md).

| Pregunta | Dónde |
|---|---|
| ¿Cómo está esta publicación ahora? | `/analytics/products/lookup` |
| ¿Qué publicaciones tiene este SKU, con su ficha completa? | `/analytics/products/by-sku` |
| ¿Cuántas visitas tuvo, y cuándo? | `/analytics/products/visit-history` |
| ¿Cuántas visitas tienen estas 10.000 publicaciones? | `/analytics/visits/bulk` |
| ¿Cómo recorro las visitas de todo el catálogo? | `/analytics/visits/catalog` |
| ¿Qué publicaciones venden más, y con qué conversión? | `/analytics/products/performance` |
| ¿Cómo viene cada categoría o cada marca? | `/analytics/categories/*`, `/analytics/brands/*` |
| ¿Qué tan al día está la base? | `/analytics/catalog/table-freshness` |
| ¿Está sana la recolección de visitas? | `/internal/catalog-backfill/visits/health` |
