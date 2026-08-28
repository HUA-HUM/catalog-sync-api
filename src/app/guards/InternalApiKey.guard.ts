import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/**
 * Protege endpoints internos con la api key de INTERNAL_API_KEY.
 * Se aplica por ruta con @UseGuards, no global, para no romper
 * los consumidores de los endpoints que hoy estan abiertos.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_KEY;

    if (!expected) {
      throw new UnauthorizedException('INTERNAL_API_KEY is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[INTERNAL_API_KEY_HEADER];

    if (typeof provided !== 'string' || !this.matches(provided, expected)) {
      throw new UnauthorizedException('Invalid api key');
    }

    return true;
  }

  private matches(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }
}
