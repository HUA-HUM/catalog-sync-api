import { FlatCategory } from 'src/core/entitis/madre-api/categories/FlatCategory';

export interface IUpsertMeliCategoriesRepository {
  upsertMany(categories: FlatCategory[]): Promise<void>;
}
