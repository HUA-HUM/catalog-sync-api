import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { IUpsertMeliCategoriesRepository } from 'src/core/adapters/postgres/categories/IUpsertMeliCategoriesRepository';
import { FlatCategory } from 'src/core/entitis/madre-api/categories/FlatCategory';
import { POSTGRES_POOL } from 'src/app/modules/database/Database.module';

/**
 * Replica el árbol de categorías de MercadoLibre en la base del catálogo
 * (Postgres, la misma de `meli_items`).
 *
 * Existe para que la web pueda resolver por JOIN todos los descendientes de una
 * categoría: MELI publica siempre en la hoja, así que sin el árbol al lado de
 * los items no hay forma de listar los productos de una categoría padre.
 */
@Injectable()
export class PostgresMeliCategoriesRepository
  implements IUpsertMeliCategoriesRepository
{
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async upsertMany(categories: FlatCategory[]): Promise<void> {
    if (!categories.length) return;

    const values = categories
      .map(
        (_, i) =>
          `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`,
      )
      .join(',');

    const params = categories.flatMap((c) => [
      c.id,
      c.name,
      c.parentId,
      c.level,
      c.path,
    ]);

    await this.pool.query(
      `
      INSERT INTO meli_categories (id, name, parent_id, level, path)
      VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        parent_id  = EXCLUDED.parent_id,
        level      = EXCLUDED.level,
        path       = EXCLUDED.path,
        updated_at = now()
      `,
      params,
    );
  }
}
