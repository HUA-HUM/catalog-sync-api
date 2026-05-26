export type MeliProductOrdersResponse = {
  results: MeliOrder[];
  paging?: {
    total?: number;
    offset?: number;
    limit?: number;
  };
};

export type MeliOrder = {
  id: number | string;
  status: string;
  dateCreated?: string | null;
  dateClosed?: string | null;
  totalAmount?: number | null;
  currencyId?: string | null;
  items?: MeliOrderItem[];
};

export type MeliOrderItem = {
  itemId: string;
  title?: string | null;
  quantity: number;
  unitPrice?: number | null;
};

export interface IUpsertMeliOrdersRepository {
  upsertOrders(params: {
    sellerId: number | string;
    orders: MeliOrder[];
  }): Promise<void>;
}
