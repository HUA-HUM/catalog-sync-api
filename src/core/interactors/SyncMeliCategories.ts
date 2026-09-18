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

      // Dos destinos. Postgres primero porque es del que depende la web: ahí
      // vive el árbol al lado de `meli_items` y sin él no se pueden resolver
      // los descendientes de una categoría.
      await this.postgresRepo.upsertMany(chunk);

      // madre-api es best-effort: si su endpoint no está disponible, no tiene
      // sentido tirar abajo un job que ya recorrió 11k categorías y que ya
      // dejó el dato donde hace falta. Queda el warning para no perderlo de
      // vista. Ambos son upserts idempotentes, así que un reintento del job
      // rehace los dos sin duplicar nada.
      try {
        await this.saveRepo.save(chunk);
      } catch (error: any) {
        console.warn(
          `⚠️ No se pudo guardar el chunk en madre-api: ${error?.message ?? error}`,
        );
      }

      console.log(`💾 Saved chunk ${i} - ${i + chunk.length}`);
    }
  }
}
