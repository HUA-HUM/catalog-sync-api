/**
 * Politica de retencion compartida por todas las colas.
 *
 * `removeOnFail: false` y `removeOnComplete: false` dejan el job en Redis para
 * siempre, con su payload y sus logs. Multiplicado por el volumen de webhooks
 * y por el job recurrente de visitas, eso es lo que venia llenando la memoria
 * del Redis gestionado.
 *
 * Los fallidos se guardan una semana porque son los que hay que mirar para
 * diagnosticar; los completados, una hora, solo para ver que la cola avanza.
 * BullMQ aplica la limpieza al cerrarse cada job, no con un timer de fondo.
 */
export const QUEUE_RETENTION = {
  removeOnComplete: {
    age: Number(process.env.QUEUE_KEEP_COMPLETED_SECONDS ?? 60 * 60),
    count: Number(process.env.QUEUE_KEEP_COMPLETED_COUNT ?? 1000),
  },
  removeOnFail: {
    age: Number(process.env.QUEUE_KEEP_FAILED_SECONDS ?? 7 * 24 * 60 * 60),
    count: Number(process.env.QUEUE_KEEP_FAILED_COUNT ?? 5000),
  },
} as const;
