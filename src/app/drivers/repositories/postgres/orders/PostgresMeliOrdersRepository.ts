import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';
import {
  IUpsertMeliOrdersRepository,
  MeliOrder,
} from 'src/core/adapters/postgres/orders/IUpsertMeliOrdersRepository';

@Injectable()
export class PostgresMeliOrdersRepository
  implements IUpsertMeliOrdersRepository
{
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async upsertOrders(params: {
    sellerId: number | string;
    orders: MeliOrder[];
  }): Promise<void> {
    if (!params.orders.length) return;

    const sellerId = Number(params.sellerId);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const order of params.orders) {
        await client.query(
          `
          INSERT INTO meli_orders (
            seller_id,
            order_id,
            status,
            date_created,
            date_closed,
            total_amount,
            currency_id,
            raw
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (seller_id, order_id) DO UPDATE SET
            status = EXCLUDED.status,
            date_created = EXCLUDED.date_created,
            date_closed = EXCLUDED.date_closed,
            total_amount = EXCLUDED.total_amount,
            currency_id = EXCLUDED.currency_id,
            raw = EXCLUDED.raw
          `,
          [
            sellerId,
            Number(order.id),
            order.status,
            order.dateCreated ?? null,
            order.dateClosed ?? null,
            order.totalAmount ?? null,
            order.currencyId ?? null,
            JSON.stringify(order),
          ],
        );

        await client.query(
          'DELETE FROM meli_order_items WHERE seller_id = $1 AND order_id = $2',
          [sellerId, Number(order.id)],
        );

        for (const [index, item] of (order.items ?? []).entries()) {
          await client.query(
            `
            INSERT INTO meli_order_items (
              seller_id,
              order_id,
              line_number,
              item_id,
              title,
              quantity,
              unit_price
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              sellerId,
              Number(order.id),
              index + 1,
              item.itemId,
              item.title ?? null,
              item.quantity,
              item.unitPrice ?? null,
            ],
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
