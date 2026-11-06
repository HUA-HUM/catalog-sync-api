import { BadRequestException } from '@nestjs/common';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  return value.trim() || undefined;
}

export function parseRequiredText(value: unknown, field: string): string {
  const text = parseText(value);

  if (!text) {
    throw new BadRequestException(`${field} is required`);
  }

  return text;
}

export function parseId(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw new BadRequestException('id must be a UUID');
  }

  return id;
}

export function parsePage(
  params: { limit?: string; offset?: string },
  limits: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number } {
  const limit = Number(params.limit ?? limits.defaultLimit);
  const offset = Number(params.offset ?? 0);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxLimit) {
    throw new BadRequestException(
      `limit must be between 1 and ${limits.maxLimit}`,
    );
  }

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new BadRequestException('offset must be 0 or greater');
  }

  return { limit, offset };
}
