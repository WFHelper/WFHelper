/**
 * wfmTypes.ts - Shared Warframe.market API response types (main-process only)
 *
 * WFM has two response envelope shapes depending on API version:
 * - v1: `{ payload: T }`
 * - v2: `{ data: T }`
 *
 * `unwrapWfmResponse()` normalises both into a plain T.
 */

/** v1 auction search: `GET /v1/auctions/search` */
export interface WfmAuctionSearchPayload {
  auctions: WfmRawAuction[];
}

/** Single auction from the v1 auction search endpoint. */
export interface WfmRawAuction {
  id: string;
  owner: { ingame_name: string; status?: string | null };
  buyout_price: number | null;
  starting_price: number | null;
  is_direct_sell: boolean;
  item: {
    name: string;
    weapon_url_name: string;
    re_rolls: number;
    attributes: WfmRawAuctionAttribute[];
  };
}

interface WfmRawAuctionAttribute {
  url_name: string;
  value: number;
  positive: boolean;
}

/** v1 auction creation response: `POST /v1/auctions/create` */
export interface WfmAuctionCreatePayload {
  auction: { id: string };
}

export interface WfmAuctionUpdatePayload {
  auction?: { id: string };
  [key: string]: unknown;
}

/** v2 order response: the `data` field of a v2 order mutation response. */
export interface WfmRawOrder {
  id: string;
  type?: string;
  order_type?: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  rank?: number | null;
  mod_rank?: number | null;
  itemId?: string;
  item?: WfmRawOrderItem;
  _catalogItem?: WfmRawOrderItem;
}

export interface WfmRawOrderItem {
  id?: string;
  url_name?: string;
  thumb?: string;
  icon?: string;
  item_name?: string;
  name?: string;
  en?: { item_name?: string };
  i18n?: { en?: { item_name?: string; thumb?: string } };
  maxRank?: number;
  max_rank?: number;
}

/** v2 order mutation wraps the order in `{ order: ... }` or returns it directly. */
export interface WfmOrderMutationData {
  order?: WfmRawOrder;
  [key: string]: unknown;
}

/** v2 order close response: `POST /v2/order/{id}/close` */
export interface WfmCloseOrderResult {
  closed: boolean;
  id: string;
  remainingQuantity: number;
}

/**
 * Unwrap a WFM API response from its envelope.
 *
 * - v2 responses: `{ data: T }` → returns `T`
 * - v1 responses: `{ payload: T }` → returns `T`
 * - Already unwrapped: returns as-is
 *
 * The caller is responsible for asserting the inner type.
 */
export function unwrapWfmResponse<T = unknown>(raw: unknown): T {
  if (raw == null || typeof raw !== "object") return raw as T;
  const obj = raw as Record<string, unknown>;
  if ("data" in obj) return obj.data as T;
  if ("payload" in obj) return obj.payload as T;
  return raw as T;
}
