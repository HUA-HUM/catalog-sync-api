import axios from 'axios';
import { MeliApiError } from './MeliApiError';

export class MeliHttpErrorHandler {
  static handle(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as
        | { message?: string; retryAfterSeconds?: number }
        | undefined;
      const url = error.config?.url;

      console.error('[MELI API ERROR]', { status, url, data });

      if (status === 429) {
        return new MeliApiError(
          '[MELI API] Rate limited by Mercado Libre',
          429,
          MeliHttpErrorHandler.readRetryAfter(error, data),
        );
      }

      switch (status) {
        case 401:
          return new MeliApiError('[MELI API] Unauthorized', 401);
        case 403:
          return new MeliApiError('[MELI API] Forbidden', 403);
        case 404:
          return new MeliApiError('[MELI API] Not found', 404);
        case 500:
          return new MeliApiError('[MELI API] Internal server error', 500);
        case 502:
          // El proxy usa 502 para "Meli fallo", distinto de un fallo propio.
          return new MeliApiError(
            `[MELI API] Upstream error from Meli${data?.message ? `: ${data.message}` : ''}`,
            502,
          );
        default:
          return new MeliApiError(
            `[MELI API] Unexpected error${status ? ` (${status})` : ''}`,
            status,
          );
      }
    }

    console.error('[MELI API ERROR] Unknown error', error);
    return new MeliApiError('[MELI API] Unknown error');
  }

  /**
   * El proxy manda la espera por dos vias: el header Retry-After, en segundos,
   * y retryAfterSeconds en el cuerpo. Se leen las dos porque un intermediario
   * puede comerse el header.
   */
  private static readRetryAfter(
    error: { response?: { headers?: unknown } },
    data?: { retryAfterSeconds?: number },
  ): number | undefined {
    const headers = error.response?.headers as
      | Record<string, string | undefined>
      | undefined;

    const fromHeader = Number(headers?.['retry-after']);
    if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;

    const fromBody = Number(data?.retryAfterSeconds);
    if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;

    return undefined;
  }
}
