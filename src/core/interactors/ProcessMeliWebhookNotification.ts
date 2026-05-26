import { Inject, Injectable } from '@nestjs/common';
import type { IMeliHttpClient } from 'src/core/adapters/mercadolibre-api/http/IMeliHttpClient';
import type {
  IUpsertMeliCatalogRepository,
  MeliBulkProduct,
} from 'src/core/adapters/postgres/catalog/IUpsertMeliCatalogRepository';
import type { MeliWebhookPayload } from 'src/app/drivers/repositories/processBull/webhooks/MeliWebhook.queue';

@Injectable()
export class ProcessMeliWebhookNotification {
  constructor(
    @Inject('IMeliHttpClient')
    private readonly meliHttpClient: IMeliHttpClient,

    @Inject('IUpsertMeliCatalogRepository')
    private readonly catalogRepository: IUpsertMeliCatalogRepository,
  ) {}

  async execute(payload: MeliWebhookPayload): Promise<void> {
    if (payload.topic === 'items') {
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

    const products = await this.meliHttpClient.get<MeliBulkProduct[]>(
      '/meli/products/bulk',
      {
        params: {
          ids: itemId,
        },
      },
    );

    if (!Array.isArray(products) || !products.length) {
      throw new Error(`Meli bulk returned no product for ${itemId}`);
    }

    await this.catalogRepository.upsertProducts(products);
  }

  private extractItemId(resource: string): string | null {
    const match = resource.match(/MLA\d+/);
    return match?.[0] ?? null;
  }
}
