export type MeliItemVisitsResponse = {
  item_id: string;
  total: number;
};

export interface IUpsertMeliVisitsRepository {
  upsertCurrentAndSnapshot(params: {
    sellerId: number | string;
    visit: MeliItemVisitsResponse;
    capturedAt?: Date;
  }): Promise<void>;
}
