# Operación

Dónde corre el servicio, cómo se despliega y qué hacer cuando algo no anda.

> Esta página no se publica en el sitio abierto: nombra el servidor y cómo se accede. Se publica solo cuando el sitio está detrás de usuario y clave.

## Dónde corre

| | |
|---|---|
| Servidor | Droplet de DigitalOcean, `104.131.117.64` |
| Carpeta | `/opt/catalog-sync-api` |
| Proceso | PM2, nombre `catalog-sync` |
| Rama de deploy | `main` |
| Puerto | 3001 |

La base es un **Postgres gestionado** de DigitalOcean y las colas van sobre un **Redis gestionado**, los dos fuera del droplet. Las credenciales están en `/opt/catalog-sync-api/.env`.

El proxy de Mercado Libre es otro droplet: `157.245.9.41`, que responde en `api.meli.loquieroaca.com`. Ahí corre `mercadolibre-api`, que es quien tiene el token de Mercado Libre.

La cuenta de DigitalOcean usa el mail `desarrollo@loquieroaca.com`: los reseteos de contraseña del droplet llegan ahí.

## Deploy

```bash
cd /opt/catalog-sync-api && git pull && npm ci && npm run build && pm2 restart catalog-sync
```

`npm ci` solo hace falta cuando cambiaron las dependencias, pero correrlo siempre es más seguro que olvidarlo cuando sí hacía falta.

Para publicar un cambio de **texto de la documentación** alcanza con `git pull`: el sitio lee los markdown en cada pedido.

### Después de desplegar

```bash
pm2 list                       # catalog-sync en online
curl -s "http://104.131.117.64:3001/internal/catalog-backfill/visits/health"
pm2 logs catalog-sync --lines 50 --nostream | grep -E "CatalogRefreshCron|visits-chunk"
```

## Verificar que está sano

### El webhook está escribiendo

La señal más directa es que la última sincronización sea de hace segundos:

```sql
SELECT max(last_synced_at), now() - max(last_synced_at) AS hace FROM meli_items;
```

Si `hace` está en minutos y creciendo, el webhook no está procesando.

### La recolección de visitas

```bash
curl -s "http://104.131.117.64:3001/internal/catalog-backfill/visits/health"
```

| Qué ves | Qué significa |
|---|---|
| `stale: false` | Está midiendo. |
| `stale: true`, `interrupted: true` | **La pasada se cortó a mitad de camino.** Quedan lotes en la cola y nadie los procesa. |
| `stale: true`, `interrupted: false` | La pasada terminó. Normal entre pasadas. |

### Las colas

Bull Board está en `/admin/queues`. Lo que conviene mirar:

- **`meli-webhooks` con cientos de miles esperando**: la ingesta está atrasada. Drena a unos 600 por minuto.
- **`catalog-backfill` con fallidos**: mirar el motivo en el job; los de visitas suelen ser `429` o lotes descartados por la red del 90%.

### El espacio en disco

```bash
df -h /
du -sh /root/.pm2/logs/*
```

Ya pasó una vez que los logs llenaron el disco: 44 GB en un solo archivo, y eso dejó el droplet inaccesible incluso por la consola web de DigitalOcean. Está configurado `pm2-logrotate` con 1 GB por archivo, 10 archivos y compresión diaria, pero conviene mirarlo de vez en cuando.

## Problemas frecuentes

### No se juntan visitas y no hay errores

Es el síntoma más engañoso que tuvo el servicio: no aparece nada en los logs porque no falla nada, simplemente no se dispara.

1. Confirmar con el endpoint de salud y con `max(captured_at)` en la base.
2. Revisar que `VISITS_REFRESH_ENABLED` **no** esté en `false` en el `.env`.
3. Revisar que el proceso esté arriba: `pm2 list`.
4. Si el proceso está arriba y la cola vacía, disparar una pasada a mano:

```bash
curl -s -X POST "http://104.131.117.64:3001/internal/catalog-backfill/visits/refresh" \
  -H "x-internal-api-key: $(grep ^INTERNAL_API_KEY= /opt/catalog-sync-api/.env | cut -d= -f2)" \
  -H "Content-Type: application/json" -d '{"limit":200}'
```

El historial es solo de altas, así que los días sin medir quedan como un hueco y **no se recuperan**: Mercado Libre no da visitas con fecha retroactiva.

### Hay que frenar las visitas ya

Sin parar el webhook de precios:

```bash
echo "VISITS_REFRESH_ENABLED=false" >> /opt/catalog-sync-api/.env && pm2 restart catalog-sync
```

Si hace falta frenar todo:

```bash
pm2 stop all && pm2 list
```

`pm2 stop catalog-sync` puede no alcanzar si el nombre no coincide o PM2 lo relevanta; `pm2 stop all` no depende del nombre. Verificar siempre con `pm2 list` que quedó en `stopped`, y después confirmar en la base que dejó de escribir.

### Se escribieron datos malos de visitas

El historial es append-only, así que las mediciones viejas siguen ahí y se puede reconstruir. El procedimiento, que ya se usó una vez:

1. Identificar la ventana exacta en que se escribió mal.
2. Borrar esas filas del historial.
3. Reconstruir el último valor de cada publicación afectada desde su última medición buena.

Correrlo siempre dentro de una transacción con `ROLLBACK` primero, mirar la muestra, y recién después con `COMMIT`.

### El webhook tiene cientos de miles de jobs esperando

Drena solo a unos 600 por minuto, así que un backlog grande tarda horas. Lo que hay que mirar es si **crece o baja**: tomar el conteo dos veces separadas por un minuto. Si crece sostenidamente, la ingesta no da y hay que revisar el proxy.

Ojo con una trampa: los jobs completados se borran al terminar, así que el contador de "completados" no sube. Que `waiting` baje sin que `completed` suba es lo normal, no pérdida de jobs.

### Redis se llena

Es la causa raíz de dos incidentes. El Redis gestionado está con política **`allkeys-lru`**, que borra las llaves menos usadas cuando se llena, y eso incluye llaves de BullMQ.

```bash
# desde el droplet, con las credenciales del .env
redis-cli --tls -h <host> -p <port> --user default -a <password> INFO memory
```

Lo que hay que mirar: `used_memory` contra `maxmemory`, y `evicted_keys` en `INFO stats`.

El arreglo de fondo es pasar la política a `noeviction` desde el panel de DigitalOcean, en Databases → el Redis → Settings. **Hacerlo cuando haya margen de memoria**: con el Redis lleno, `noeviction` hace que las escrituras fallen con error en vez de perderse en silencio. Mejor que perder datos, pero rompe la ingesta.

### Mercado Libre devuelve 429

Es esperable y el servicio lo maneja: espera lo que indica `Retry-After`. Si aparece mucho en los logs, hay dos palancas, las dos por `.env` y sin deploy:

```bash
# menos publicaciones por lote
VISITS_REFRESH_CHUNK_SIZE=50
# menos jobs en paralelo
CATALOG_BACKFILL_CONCURRENCY=1
```

Subir la concurrencia **no** mejora el rendimiento: está medido en [Visitas](visitas.md).

### No entro al droplet por SSH

Ya pasó, y la causa fue el disco lleno: con el disco al 100% ni la consola web de DigitalOcean deja entrar. La salida fue montar la **Recovery ISO** desde el panel, entrar por la consola de recuperación, truncar el log gigante y reiniciar.

Los reseteos de contraseña de root llegan al mail `desarrollo@loquieroaca.com`.

## Las credenciales del sitio de documentación

El sitio queda abierto si no están configuradas, y en ese caso no publica esta página. Para que pida usuario y clave:

```bash
echo "DOCS_SITE_USER=tlq" >> /opt/catalog-sync-api/.env
echo "DOCS_SITE_PASSWORD=<una clave>" >> /opt/catalog-sync-api/.env
pm2 restart catalog-sync
```

Para rotarlas, cambiar los valores en el `.env` y reiniciar. No hay sesión ni cookie: es HTTP Basic, así que el cambio tiene efecto en el siguiente pedido.
