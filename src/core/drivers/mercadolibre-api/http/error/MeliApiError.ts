/**
 * Error del proxy de Meli que conserva el status y el Retry-After.
 *
 * Antes todo se colapsaba a `new Error('[MELI API] ...')` y el status se
 * perdia. Con un 429 eso es caro: el reintento usaba su backoff fijo de 5 s,
 * 5 s y 20 s contra un limite de tasa que pedia esperar 60, asi que cada
 * reintento volvia a chocar y a gastar cuota. El 40% de fallos del endpoint de
 * visitas se pagaba integro en esperas inutiles.
 *
 * El proxy ahora responde 429 con el header Retry-After y un cuerpo con
 * retryAfterSeconds; esta clase los sube hasta el reintento.
 */
export class MeliApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'MeliApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}
