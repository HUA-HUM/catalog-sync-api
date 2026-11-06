import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  parseId,
  parsePage,
  parseRequiredText,
  parseText,
} from 'src/app/services/marketplace/marketplace.validation';
import type {
  IMarketplaceProductsRepository,
  MarketplaceProductChanges,
  MarketplaceProductInput,
  MarketplaceProductRow,
  MarketplaceProductsStatusCount,
} from 'src/core/adapters/postgres/marketplace/IMarketplaceProductsRepository';

const MAX_BULK_ITEMS = 1000;
// Lo que entra en numeric(15,2) y en integer
const MAX_PRICE = 9_999_999_999_999.99;
const MAX_STOCK = 2_147_483_647;
// JSON.stringify deja estos dos como escape, y jsonb no acepta ninguno: un
// caracter nulo o la mitad de un emoji cortado. El lookbehind saltea "\\\\u0000".
const UNSTORABLE_TEXT = /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/i;
const LIST_LIMITS = { defaultLimit: 100, maxLimit: 500 };
const UNIQUE_VIOLATION = '23505';

export interface MarketplaceProductBody {
  externalId?: unknown;
  sellerSku?: unknown;
  marketplaceSku?: unknown;
  price?: unknown;
  stock?: unknown;
  status?: unknown;
  raw?: unknown;
}

export interface BulkMarketplaceProductsBody {
  marketplace?: unknown;
  items?: unknown;
}

export interface CreateMarketplaceProductBody extends MarketplaceProductBody {
  marketplace?: unknown;
}

export interface MarketplaceProductRejection {
  externalId: string | null;
  reason: string;
}

export interface ListMarketplaceProductsParams {
  marketplace?: string;
  limit?: string;
  offset?: string;
  sku?: string;
  status?: string;
}

@Injectable()
export class MarketplaceProductsService {
  constructor(
    @Inject('IMarketplaceProductsRepository')
    private readonly repository: IMarketplaceProductsRepository,
  ) {}

  async bulkUpsert(body?: BulkMarketplaceProductsBody) {
    const marketplace = parseRequiredText(body?.marketplace, 'marketplace');
    const { items, rejected } = this.parseItems(body?.items);

    await this.repository.bulkUpsert(marketplace, items);

    return { marketplace, saved: items.length, rejected };
  }

  async create(body?: CreateMarketplaceProductBody) {
    const marketplace = parseRequiredText(body?.marketplace, 'marketplace');
    const item = this.parseItem(body ?? {}, 'body');

    try {
      return await this.repository.create(marketplace, item);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException(
          `${marketplace} already has a product with externalId ${item.externalId}`,
        );
      }

      throw error;
    }
  }

  async findById(id: string) {
    const product = await this.repository.findById(parseId(id));

    return this.assertFound(product, id);
  }

  async update(id: string, body?: MarketplaceProductBody) {
    const changes = this.parseChanges(body ?? {});
    const product = await this.repository.update(parseId(id), changes);

    return this.assertFound(product, id);
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.repository.delete(parseId(id));

    if (!deleted) {
      throw new NotFoundException(`Marketplace product ${id} not found`);
    }
  }

  async exists(marketplace?: string, sellerSku?: string) {
    const exists = await this.repository.existsBySellerSku(
      parseRequiredText(marketplace, 'marketplace'),
      parseRequiredText(sellerSku, 'sellerSku'),
    );

    return { exists };
  }

  async list(params: ListMarketplaceProductsParams) {
    const filters = {
      marketplace: parseRequiredText(params.marketplace, 'marketplace'),
      sku: parseText(params.sku),
      status: parseText(params.status),
    };
    const page = parsePage(params, LIST_LIMITS);

    const [items, statusCounts] = await Promise.all([
      this.repository.list(filters, page),
      this.repository.countByStatus(filters),
    ]);
    const total = statusCounts.reduce((sum, row) => sum + row.total, 0);
    const nextOffset = page.offset + page.limit;
    const hasNext = nextOffset < total;

    return {
      marketplace: filters.marketplace,
      filters: { sku: filters.sku ?? null, status: filters.status ?? null },
      items,
      limit: page.limit,
      offset: page.offset,
      count: items.length,
      total,
      summary: this.buildSummary(filters.marketplace, total, statusCounts),
      hasNext,
      nextOffset: hasNext ? nextOffset : null,
    };
  }

  /* Un producto invalido no frena al resto: vuelve en rejected con su motivo */
  private parseItems(value: unknown): {
    items: MarketplaceProductInput[];
    rejected: MarketplaceProductRejection[];
  } {
    if (!Array.isArray(value) || !value.length) {
      throw new BadRequestException('items must not be empty');
    }

    if (value.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(
        `items must have at most ${MAX_BULK_ITEMS} products`,
      );
    }

    const items: MarketplaceProductInput[] = [];
    const rejected: MarketplaceProductRejection[] = [];

    value.forEach((item: MarketplaceProductBody | null, index) => {
      try {
        items.push(this.parseItem(item ?? {}, `items[${index}]`));
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;

        rejected.push({
          externalId: parseText(item?.externalId) ?? null,
          reason: error.message,
        });
      }
    });

    // Si un external_id viene repetido queda el ultimo: el upsert no acepta dos
    return {
      items: [
        ...new Map(items.map((item) => [item.externalId, item])).values(),
      ],
      rejected,
    };
  }

  private parseItem(
    item: MarketplaceProductBody,
    path: string,
  ): MarketplaceProductInput {
    const parsed = {
      externalId: parseRequiredText(item.externalId, `${path}.externalId`),
      sellerSku: parseRequiredText(item.sellerSku, `${path}.sellerSku`),
      marketplaceSku: parseText(item.marketplaceSku) ?? null,
      price: this.parsePrice(item.price, `${path}.price`),
      stock: this.parseStock(item.stock, `${path}.stock`),
      status: parseRequiredText(item.status, `${path}.status`),
      raw: this.parseRaw(item.raw, `${path}.raw`),
    };

    if (UNSTORABLE_TEXT.test(JSON.stringify(parsed))) {
      throw new BadRequestException(`${path} has text that cannot be stored`);
    }

    return parsed;
  }

  private parseChanges(body: MarketplaceProductBody) {
    const changes: MarketplaceProductChanges = {};

    if (body.sellerSku !== undefined) {
      changes.sellerSku = parseRequiredText(body.sellerSku, 'sellerSku');
    }

    if (body.marketplaceSku !== undefined) {
      changes.marketplaceSku = parseRequiredText(
        body.marketplaceSku,
        'marketplaceSku',
      );
    }

    if (body.price !== undefined) {
      changes.price = this.parsePrice(body.price, 'price');
    }

    if (body.stock !== undefined) {
      changes.stock = this.parseStock(body.stock, 'stock');
    }

    if (body.status !== undefined) {
      changes.status = parseRequiredText(body.status, 'status');
    }

    if (body.raw !== undefined) {
      changes.raw = this.parseRaw(body.raw, 'raw');
    }

    if (!Object.keys(changes).length) {
      throw new BadRequestException('body must have at least one change');
    }

    return changes;
  }

  private parsePrice(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${field} must be a number`);
    }

    if (Math.abs(value) > MAX_PRICE) {
      throw new BadRequestException(`${field} is out of range`);
    }

    return value;
  }

  private parseStock(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new BadRequestException(`${field} must be an integer`);
    }

    if (Math.abs(value) > MAX_STOCK) {
      throw new BadRequestException(`${field} is out of range`);
    }

    return value;
  }

  private parseRaw(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an object`);
    }

    return value as Record<string, unknown>;
  }

  private assertFound(product: MarketplaceProductRow | null, id: string) {
    if (!product) {
      throw new NotFoundException(`Marketplace product ${id} not found`);
    }

    return product;
  }

  private buildSummary(
    marketplace: string,
    total: number,
    rows: MarketplaceProductsStatusCount[],
  ) {
    const statuses = rows.map((row) => ({
      ...row,
      percentage: Number(((row.total / total) * 100).toFixed(2)),
    }));

    return {
      marketplace,
      total,
      statuses,
      statusMap: Object.fromEntries(
        statuses.map((row) => [row.status, row.total]),
      ),
      statusPercentageMap: Object.fromEntries(
        statuses.map((row) => [row.status, row.percentage]),
      ),
    };
  }
}
