# Visitas

Las visitas son la parte más delicada del servicio. Esta página existe porque casi todo lo que parece obvio sobre ellas es falso, y cada cosa falsa nos costó un incidente.

## Qué mide el número

Para cada publicación guardamos un número de visitas y la fecha en que lo medimos. Hay dos tablas: una con el **último valor** de cada publicación, y otra con el **historial completo** de todas las mediciones, que arranca el 28 de mayo de 2026 y tiene unos 36 millones de filas.

Lo que **no** sabemos es qué período mide ese número.

> **No se pueden restar dos mediciones para obtener las visitas de un período.**

El motivo es que el número **baja**. Si fuera un acumulado histórico, solo podría subir. Un caso concreto, MLA1538120729:

| Medición | Visitas |
|---|---|
| 30/05 a 17/09 | 143 |
| 21/09 | 138 |
| 30/09 | 132 |
| 04/10 | 122 |
| 13/10 | 107 |
| 22/10 | 94 |
| 28/10 | 87 |

Clavado en 143 durante casi cuatro meses y después bajando sin parar. Eso es compatible con una **ventana móvil** —algo tipo "visitas de los últimos N días"— y no con un total desde que se publicó. Las visitas viejas se van cayendo de la ventana.

La definición exacta la tiene Mercado Libre y todavía no está confirmada. Hasta que lo esté, la regla es: **cada medición vale como la foto del momento en que se tomó, y nada más**.

### Qué significa un cero

Un cero quiere decir que la publicación no tuvo visitas en la ventana que mide Mercado Libre. Es normal y frecuente: **alrededor de la mitad del catálogo está en cero**, porque hay 788.166 publicaciones cerradas y una cola larga de activas sin tráfico.

O sea: ver muchos ceros no es señal de que algo esté roto. Era así en septiembre y sigue siendo así ahora.

## Cada cuánto se mide cada publicación

Mercado Libre raciona estas consultas, así que no alcanza para medir todo seguido. En vez de medir todo mal, se mide seguido lo que importa. Tres grupos:

| Grupo | Qué son | Cuántas | Cada cuánto |
|---|---|---|---|
| Nuevas | Creadas en los últimos 30 días | 231.633 | 1 día |
| Con visitas | Ya tienen tráfico registrado | 538.599 | 4 días |
| El resto | Sin visitas y sin ventas | 642.100 | 14 días |

El grupo de las nuevas existe por un error que tuvimos: una publicación recién creada tiene cero visitas **porque nunca la medimos**, no porque esté muerta. Sin ese grupo, 195.996 publicaciones nuevas caían en el grupo de 14 días, que es justo al revés de lo que conviene.

La selección sale **ordenada por grupo**. Si el presupuesto del día no alcanza para todo, lo que queda sin medir es lo que menos importa. Antes se cortaba por donde fuera.

### El costo de esta decisión

Una publicación del grupo del resto que de golpe empieza a recibir visitas se detecta hasta 14 días después, porque solo lo sabemos al medirla. Las nuevas están cubiertas por su propio grupo, pero una publicación vieja que revive, no.

Si eso resulta demasiado espaciado, el número se cambia por configuración: `VISITS_TIER_REST_STALE_DAYS`.

## El techo de Mercado Libre

Este es el límite duro y no se puede mover desde acá:

| | |
|---|---|
| Publicaciones medidas por minuto | ~300 |
| De lo que se pide, cuánto mide | ~20% |
| Pasada completa sobre las activas | ~69 horas |

Mercado Libre acepta **un solo identificador por consulta**: con dos o más responde `400 "maximum amount of items to query is 1"`. Así que pedir en lotes ahorra viajes entre nuestros servicios, pero no ahorra consultas a Mercado Libre: sigue siendo una por publicación.

Y subir la concurrencia **no ayuda**: medido, con 5 procesos en paralelo se consiguen 268 mediciones por minuto y con 1 proceso se consiguen 276. Lo único que cambia es cuánta cuota se desperdicia. Por eso la concurrencia está en 1.

### Lo que devuelve y lo que no

De cada lote que se pide, una parte vuelve medida y el resto vuelve **omitido**. Omitido no significa "no tiene visitas": medido sobre 300 publicaciones activas, 117 vinieron omitidas y 106 de esas tenían un valor real guardado. Es un fallo intermitente de Mercado Libre, publicación por publicación.

A una publicación omitida **no se le toca la fecha de medición**, así que vuelve a entrar en la pasada siguiente por sí sola. No hace falta reintentar nada a mano.

## Los dos incidentes, y qué se puso para que no se repitan

### La recolección se detuvo seis días sin un solo error

El horario de la pasada estaba guardado como una llave en Redis. Redis llegó a su límite de memoria y, con la política `allkeys-lru`, empezó a borrar las llaves menos usadas. La del horario se tocaba una vez por hora, así que fue de las primeras. Desapareció y nada la recreó.

Resultado: del 6 al 13 de noviembre de 2026 no se midió nada, **sin un solo error en los logs**. Se detectó porque alguien notó que el dato más nuevo era viejo.

Qué se puso:

- El horario vive en el **código**, no en Redis. Se registra en cada arranque y Redis no lo puede borrar.
- Un endpoint de salud, `/internal/catalog-backfill/visits/health`, que dice cuándo fue la última medición y si la pasada se cortó a mitad de camino.

### Se sobreescribieron 57.584 valores con ceros

El proxy de Mercado Libre devolvía `total: 0` tanto para "no tiene visitas" como para "Mercado Libre no me contestó", sin distinguirlos. Con Mercado Libre rechazando consultas, los lotes volvían 99,8% en cero y el servicio los guardó como si fueran mediciones.

En diez minutos se escribieron 107.769 mediciones en cero y 57.584 publicaciones perdieron su valor real. Se revirtió reconstruyendo cada publicación desde su última medición buena: el historial es solo de altas, así que las filas viejas nunca se tocaron.

Qué se puso:

- El proxy ahora **omite** del resultado los identificadores que Mercado Libre no midió, en vez de devolverlos en cero. Un cero que llega es un cero real.
- Del lado del servicio, una red de seguridad: si un lote vuelve con más del 90% en cero, **se descarta entero y se reintenta** en vez de escribirlo. Un lote sano ronda el 50%.
- Esa red solo opina a partir de 20 publicaciones devueltas. Con menos, la proporción es ruido: un lote que devuelve una sola publicación con un cero legítimo daba 100% y se descartaba por error.
- Un interruptor, `VISITS_REFRESH_ENABLED=false`, para apagar solo las visitas sin parar el webhook de precios. La primera vez que hizo falta no existía y hubo que parar el servicio entero.

> La red del 90% es un parche con un límite conocido: no distingue un lote genuinamente malo de uno roto, solo apuesta a la proporción. Si algún día hay un lote real con 95% de publicaciones sin visitas, lo va a descartar por error.

## Cómo consultar el historial

El historial se lee con `/analytics/products/visit-history`, por MLA o por SKU, con rango de fechas opcional. Devuelve la serie cruda: una fila por medición, con su fecha.

```bash
curl -s -H "x-internal-api-key: $INTERNAL_API_KEY" \
  "http://104.131.117.64:3001/analytics/products/visit-history?ids=MLA1538120729&from=2026-09-01"
```

El endpoint **no calcula deltas a propósito**, por lo explicado arriba. Si alguien necesita "visitas del mes", primero hay que confirmar con Mercado Libre qué período mide el número.

Los parámetros están en la [referencia de la API](api.md#visitas).
