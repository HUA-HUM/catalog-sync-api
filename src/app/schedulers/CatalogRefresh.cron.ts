import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CatalogBackfillService } from 'src/app/services/catalogBackfill/CatalogBackfillService';

/**
 * Horarios de las pasadas periodicas del catalogo.
 *
 * Viven aca, en el codigo, y no como un scheduler de BullMQ guardado en Redis.
 * Esa es toda la razon de existir de este archivo.
 *
 * Lo que fallaba antes: el disparador era una llave de Redis creada una sola
 * vez al arrancar la app. El Redis gestionado estaba al tope de memoria con
 * politica `allkeys-lru`, asi que empezo a desalojar llaves solo; la del
 * scheduler de visitas, que se tocaba una vez por hora, era la menos usada y la
 * primera candidata. Desaparecio, la recoleccion de visitas se detuvo el
 * 06/11/2026 y no hubo un solo error en los logs: simplemente dejo de haber
 * capturas. Se detecto seis dias despues y porque alguien noto que el dato
 * ultimo era viejo.
 *
 * Con `@Cron` el horario se registra en cada arranque del proceso y Redis no lo
 * puede borrar. Redis queda solo como transporte de los jobs: si pierde los
 * jobs encolados, la pasada siguiente los vuelve a encolar.
 *
 * Nota: si alguna vez se corre la app en varias instancias, estos crons se
 * disparan una vez por instancia. Hoy es un solo proceso de PM2.
 */
@Injectable()
export class CatalogRefreshCron {
  constructor(private readonly service: CatalogBackfillService) {}

  /**
   * Visitas, todos los dias a las 03:00 de Argentina.
   *
   * Encola una pasada sobre las publicaciones cuya captura ya vencio. Son
   * ~1.248.321 activas, en lotes de 500 contra el endpoint bulk del proxy:
   * ~2.500 pedidos HTTP, no 1.248.321 como antes.
   */
  @Cron(process.env.VISITS_REFRESH_CRON ?? '0 3 * * *', {
    name: 'visits-refresh-daily',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async refreshVisitsDaily(): Promise<void> {
    try {
      const result = await this.service.enqueueVisitsRefresh({});
      console.log(
        `[CatalogRefreshCron] visitas encoladas run=${result.run_id} staleAfterDays=${result.stale_after_days} statuses=${result.statuses?.join('|')}`,
      );
    } catch (error) {
      console.error('[CatalogRefreshCron] fallo la pasada de visitas', error);
    }
  }

  /**
   * Catalogo completo, los domingos a las 02:00 de Argentina.
   *
   * Relee cada publicacion desde Meli y reescribe precio, stock, estado y
   * detalle. Cubre el caso de un cambio que el webhook se perdio, que es algo
   * que ya nos paso.
   *
   * Sin ordenes ni visitas: las ordenes llegan por su propio flujo y las visitas
   * tienen la pasada diaria de arriba. Pedirlas aca seria hacer dos veces el
   * mismo trabajo contra Meli.
   */
  @Cron(process.env.CATALOG_REFRESH_CRON ?? '0 2 * * 0', {
    name: 'catalog-refresh-weekly',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async refreshCatalogWeekly(): Promise<void> {
    try {
      const result = await this.service.startFullBackfill({
        includeOrders: false,
        includeVisits: false,
      });
      console.log(
        `[CatalogRefreshCron] catalogo completo encolado run=${result.run_id}`,
      );
    } catch (error) {
      console.error('[CatalogRefreshCron] fallo la pasada de catalogo', error);
    }
  }
}
