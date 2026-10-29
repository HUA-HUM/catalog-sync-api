import { Inject, Injectable } from '@nestjs/common';
import type { IMeliHttpClient } from 'src/core/adapters/mercadolibre-api/http/IMeliHttpClient';
import type {
  IUpsertMeliCatalogRepository,
  MeliBulkProduct,
} from 'src/core/adapters/postgres/catalog/IUpsertMeliCatalogRepository';
import type { MeliWebhookPayload } from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.queue';
import {
  CatalogBackfillJobs,
  CatalogBackfillQueue,
} from 'src/app/drivers/repositories/processBull/catalogBackfill/CatalogBackfill.queue';
import { MeliWebhookLogger } from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.logger';

import { QUEUE_RETENTION } from 'src/app/drivers/repositories/processBull/queue.retention';
type PendingNotification = {
  itemId: string;
  payload: MeliWebhookPayload;
  resolve: () => void;
  reject: (error: unknown) => void;
};

@Injectable()
export class ProcessMeliWebhookNotification {
  constructor(
    @Inject('IMeliHttpClient')
    private readonly meliHttpClient: IMeliHttpClient,

    @Inject('IUpsertMeliCatalogRepository')
    private readonly catalogRepository: IUpsertMeliCatalogRepository,
  ) {}

  /**
   * Topics que representan un cambio real sobre la publicacion y obligan a
   * releer el producto. `items_prices` y `public_offers` son los que llegan
   * cuando cambia el precio de lista o entra/sale una promocion.
   * `price_suggestion` y `public_candidates` quedan afuera a proposito: son
   * sugerencias e invitaciones, no cambios efectivos.
   */
  private static readonly REFETCH_TOPICS = new Set([
    'items',
    'items_prices',
    'public_offers',
  ]);

  /** /meli/products/bulk acepta hasta 100 ids por llamada. */
  private static readonly BATCH_SIZE = Number(
    process.env.MELI_WEBHOOK_BATCH_SIZE ?? 100,
  );

  /** Cuanto espera un lote incompleto antes de salir igual. */
  private static readonly BATCH_WAIT_MS = Number(
    process.env.MELI_WEBHOOK_BATCH_WAIT_MS ?? 400,
  );

  /**
   * Ids por llamada HTTP. El lote acumulado se parte en pedazos de este
   * tamanio: el proxy devuelve vacio con lotes grandes y el backfill ya venia
   * pidiendo de a 20.
   */
  private static readonly BULK_CHUNK_SIZE = Number(
    process.env.MELI_BULK_CHUNK_SIZE ?? 20,
  );

  private pending: PendingNotification[] = [];
  private timer: NodeJS.Timeout | null = null;

  async execute(payload: MeliWebhookPayload): Promise<void> {
    if (ProcessMeliWebhookNotification.REFETCH_TOPICS.has(payload.topic)) {
      await this.processItemNotification(payload);
      return;
    }

    console.log(
      `[ProcessMeliWebhookNotification] Unsupported topic=${payload.topic} resource=${payload.resource}`,
    );
  }

  private async processItemNotification(
    payload: MeliWebhookPayload,
  ): Promise<void> {
    const itemId = this.extractItemId(payload.resource);

    if (!itemId) {
      throw new Error(`Could not extract item id from ${payload.resource}`);
    }

    await this.enqueueForBatch(itemId, payload);
  }

  /**
   * Acumula los MLAs de varias notificaciones y los resuelve en una sola
   * llamada a /meli/products/bulk, que acepta hasta 100 ids. El job de BullMQ
   * queda esperando su lote, asi cada notificacion conserva su propio
   * resultado para los reintentos.
   *
   * Para que el lote se llene hace falta que haya muchos jobs en vuelo a la
   * vez: subir MELI_WEBHOOK_WORKER_CONCURRENCY por encima de BATCH_SIZE.
   */
  private enqueueForBatch(
    itemId: string,
    payload: MeliWebhookPayload,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ itemId, payload, resolve, reject });

      if (this.pending.length >= ProcessMeliWebhookNotification.BATCH_SIZE) {
        void this.flush();
        return;
      }

      this.timer ??= setTimeout(
        () => void this.flush(),
        ProcessMeliWebhookNotification.BATCH_WAIT_MS,
      );
    });
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.pending.splice(0, this.pending.length);
    if (!batch.length) return;

    const itemIds = [...new Set(batch.map((entry) => entry.itemId))];
    const products: MeliBulkProduct[] = [];

    /**
     * Ids cuya consulta fallo a nivel HTTP. Solo esos jobs se rechazan: un id
     * que simplemente no vuelve en la respuesta no es un error reintentable
     * (la publicacion puede no existir mas), y tratarlo como tal hacia que un
     * lote entero se reintentara en loop sin avanzar nunca.
     */
    const failedIds = new Set<string>();
    let lastError: unknown = null;

    // El proxy no sostiene lotes grandes: el backfill ya pide de a 20.
    for (const chunk of this.chunk(
      itemIds,
      ProcessMeliWebhookNotification.BULK_CHUNK_SIZE,
    )) {
      try {
        const chunkProducts = await this.meliHttpClient.get<MeliBulkProduct[]>(
          '/meli/products/bulk',
          { params: { ids: chunk.join(',') } },
        );

        if (Array.isArray(chunkProducts)) {
          products.push(...chunkProducts);
        }
      } catch (error) {
        lastError = error;
        chunk.forEach((itemId) => failedIds.add(itemId));
        MeliWebhookLogger.error(
          `bulk chunk failed ids=${chunk.length} first=${chunk[0]}`,
          error,
        );
      }
    }

    try {
      if (products.length) {
        await this.catalogRepository.upsertProducts(products);
        await this.enqueueOrders(products, batch);
      }

      MeliWebhookLogger.processing(
        `synced batch items=${itemIds.length} products=${products.length} notifications=${batch.length} failed=${failedIds.size}`,
      );
    } catch (error) {
      // Fallo el upsert: eso si es reintentable para todo el lote.
      MeliWebhookLogger.error(
        `batch upsert failed items=${itemIds.length}`,
        error,
      );
      batch.forEach((entry) => entry.reject(error));
      return;
    }

    batch.forEach((entry) => {
      if (failedIds.has(entry.itemId)) {
        entry.reject(lastError);
        return;
      }
      entry.resolve();
    });
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  private async enqueueOrders(
    products: MeliBulkProduct[],
    batch: PendingNotification[],
  ): Promise<void> {
    for (const product of products) {
      if (Number(product.soldQuantity ?? 0) <= 0) continue;

      const sellerId =
        product.seller_id ??
        batch.find((entry) => entry.itemId === product.id)?.payload.user_id;

      if (!sellerId) {
        MeliWebhookLogger.error(
          `seller_id is required to enqueue orders for ${product.id}`,
        );
        continue;
      }

      await CatalogBackfillQueue.add(
        CatalogBackfillJobs.SYNC_ORDERS_FOR_ITEM,
        {
          runId: `meli-webhook-${Date.now()}`,
          sellerId,
          itemId: product.id,
          status: 'paid',
          limit: 50,
        },
        {
          jobId: `meli-webhook-orders-${product.id}-${Date.now()}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: QUEUE_RETENTION.removeOnFail,
        },
      );
    }
  }

  private extractItemId(resource: string): string | null {
    const match = resource.match(/MLA\d+/);
    return match?.[0] ?? null;
  }
}
