import { Inject, Injectable } from '@nestjs/common';
import type { IGetCategoriesRepository } from '../adapters/mercadolibre-api/categories/IGetCategoriesRepository';
import type { ISaveMeliCategoriesRepository } from '../adapters/madre-api/categories/ISaveMeliCategoriesRepository';
import type { IUpsertMeliCategoriesRepository } from '../adapters/postgres/categories/IUpsertMeliCategoriesRepository';
import { FlatCategory } from '../entitis/madre-api/categories/FlatCategory';

@Injectable()
export class SyncMeliCategories {
  private readonly CHUNK_SIZE = 200;

  constructor(
    @Inject('IGetCategoriesRepository')
    private readonly categoriesRepo: IGetCategoriesRepository,

    @Inject('ISaveMeliCategoriesRepository')
    private readonly saveRepo: ISaveMeliCategoriesRepository,

    @Inject('IUpsertMeliCategoriesRepository')
    private readonly postgresRepo: IUpsertMeliCategoriesRepository,
  ) {}

  async execute(): Promise<void> {
    console.log('🚀 Starting full categories sync...');

    const roots = await this.categoriesRepo.getTree();
    console.log(`📦 Roots found: ${roots.length}`);

    const flat: FlatCategory[] = [];

    const CONCURRENCY = 4;

    for (let i = 0; i < roots.length; i += CONCURRENCY) {
      const slice = roots.slice(i, i + CONCURRENCY);

      await Promise.all(
        slice.map((root) =>
          this.processCategoryRecursive(root.id, null, 1, null, flat),
        ),
      );
    }

    console.log(`🌳 Total categories flattened: ${flat.length}`);

    await this.saveInChunks(flat);

    console.log('✅ Categories sync completed');
  }

  // 🔥 RECURSIVIDAD REAL
  private async processCategoryRecursive(
    categoryId: string,
    parentId: string | null,
    level: number,
    parentPath: string | null,
    accumulator: FlatCategory[],
  ): Promise<void> {
    const category = await this.categoriesRepo.getBranchById(categoryId);

    const path = parentPath ? `${parentPath}.${category.id}` : category.id;

    accumulator.push({
      id: category.id,
      name: category.name,
      parentId,
      level,
      path,
    });

    if (!category.children?.length) return;

    for (const child of category.children) {
      await this.processCategoryRecursive(
        child.id,
        category.id,
        level + 1,
        path,
        accumulator,
      );
      console.log(
        `🔎 Processing ${category.id} | level=${level} | children=${category.children?.length ?? 0}`,
      );
    }
  }

  private async saveInChunks(categories: FlatCategory[]) {
    for (let i = 0; i < categories.length; i += this.CHUNK_SIZE) {
      const chunk = categories.slice(i, i + this.CHUNK_SIZE);

      // Dos destinos: madre-api (MySQL, uso de negocio) y la base del catálogo
      // (Postgres), donde la web necesita el árbol al lado de `meli_items` para
      // poder resolver los descendientes de una categoría por JOIN.
      // Ambos son upserts idempotentes, así que si falla uno el reintento del
      // job rehace los dos sin duplicar nada.
      await this.saveRepo.save(chunk);
      await this.postgresRepo.upsertMany(chunk);

      console.log(`💾 Saved chunk ${i} - ${i + chunk.length}`);
    }
  }
}
