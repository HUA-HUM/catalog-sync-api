import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  parseId,
  parsePage,
  parseRequiredText,
} from 'src/app/services/marketplace/marketplace.validation';
import type { IMarketplaceSyncRunsRepository } from 'src/core/adapters/postgres/marketplace/IMarketplaceSyncRunsRepository';

const LIST_LIMITS = { defaultLimit: 20, maxLimit: 100 };

export interface MarketplaceSyncRunProgressBody {
  batches?: unknown;
  items?: unknown;
  failed?: unknown;
}

export interface ListMarketplaceSyncRunsParams {
  marketplace?: string;
  limit?: string;
  offset?: string;
}

@Injectable()
export class MarketplaceSyncRunsService {
  constructor(
    @Inject('IMarketplaceSyncRunsRepository')
    private readonly repository: IMarketplaceSyncRunsRepository,
  ) {}

  async start(marketplace: unknown) {
    const { id, startedAt } = await this.repository.start(
      parseRequiredText(marketplace, 'marketplace'),
    );

    return { runId: id, status: 'RUNNING', startedAt };
  }

  async reportProgress(
    id: string,
    body?: MarketplaceSyncRunProgressBody,
  ): Promise<void> {
    const found = await this.repository.increment(parseId(id), {
      batches: this.parseCount(body?.batches, 'batches'),
      items: this.parseCount(body?.items, 'items'),
      failed: this.parseCount(body?.failed, 'failed'),
    });

    this.assertFound(found, id);
  }

  async finish(id: string, status: unknown) {
    const parsedStatus = parseRequiredText(status, 'status');
    const found = await this.repository.finish(parseId(id), parsedStatus);

    this.assertFound(found, id);

    return { runId: id, status: parsedStatus };
  }

  async fail(id: string, errorMessage: unknown) {
    const parsedMessage = parseRequiredText(errorMessage, 'errorMessage');
    const found = await this.repository.fail(parseId(id), parsedMessage);

    this.assertFound(found, id);

    return { runId: id, status: 'FAILED', errorMessage: parsedMessage };
  }

  async list(params: ListMarketplaceSyncRunsParams) {
    const page = parsePage(params, LIST_LIMITS);
    const items = await this.repository.list(
      parseRequiredText(params.marketplace, 'marketplace'),
      page,
    );

    return { items, limit: page.limit, offset: page.offset };
  }

  private parseCount(value: unknown, field: string): number {
    if (value === undefined) return 0;

    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new BadRequestException(`${field} must be 0 or greater`);
    }

    return value;
  }

  private assertFound(found: boolean, id: string): void {
    if (!found) {
      throw new NotFoundException(`Marketplace sync run ${id} not found`);
    }
  }
}
