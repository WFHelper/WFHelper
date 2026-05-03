import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

/**
 * wfmOrders.ts — Warframe.market order management (main-process only)
 *
 * Provides read and CRUD operations for the authenticated user's orders.
 * All data is normalised into a renderer-friendly shape before being returned.
 */

import { requestV2 } from "./wfmClient";
import { getInGameName } from "./wfmSession";
import * as wfmCatalog from "./wfmCatalog";
import type { WfmRawOrder, WfmRawOrderItem, WfmOrderMutationData, WfmCloseOrderResult } from "./wfmTypes";
import { unwrapWfmResponse } from "./wfmTypes";

import { formatWfmAssetUrl } from "../config/shared/wfm";


export interface NormalisedOrder {
  id: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  itemId: string | null;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
}


function normalise(raw: WfmRawOrder, forcedType?: string): NormalisedOrder {
  // v2: item details come from catalog enrichment (raw._catalogItem), not embedded object
  const item: WfmRawOrderItem = raw._catalogItem || raw.item || {};
  const thumb = item.thumb || item.icon || "";
  const imageUrl = formatWfmAssetUrl(thumb);

  return {
    id: raw.id,
    // v2 uses 'type', v1 used 'order_type'
    orderType: raw.type || raw.order_type || forcedType || "sell",
    platinum: raw.platinum ?? 0,
    quantity: raw.quantity ?? 1,
    visible: raw.visible ?? true,
    // v2 uses 'rank', v1 used 'mod_rank'
    modRank: raw.rank ?? raw.mod_rank ?? null,
    itemId: item.id || raw.itemId || null,
    itemName:
      item.en?.item_name || item.i18n?.en?.item_name || item.item_name || item.name || "(unknown)",
    itemUrlName: item.url_name || null,
    itemThumb: imageUrl,
  };
}

const log = withScope("wfmOrders");

function _extractOrders(data: unknown): { sell: NormalisedOrder[]; buy: NormalisedOrder[] } {
  // v2 wraps in { data: ... }, v1 wraps in { payload: ... }
  const payload = unwrapWfmResponse<Record<string, unknown>>(data);
  let sell: NormalisedOrder[];
  let buy: NormalisedOrder[];

  // Helper: works for both v2 ('type') and v1 ('order_type')
  const getType = (o: WfmRawOrder) => o.type || o.order_type || "";

  const p = payload as Record<string, unknown>;
  const sellOrders = p?.sell_orders as WfmRawOrder[] | undefined;
  const buyOrders = p?.buy_orders as WfmRawOrder[] | undefined;
  const groupedSell = p?.sell as WfmRawOrder[] | undefined;
  const groupedBuy = p?.buy as WfmRawOrder[] | undefined;
  const ordersList = p?.orders as WfmRawOrder[] | undefined;

  if (sellOrders || buyOrders) {
    // v1 shape: { sell_orders: [], buy_orders: [] }
    sell = (sellOrders || []).map((o) => normalise(o, "sell"));
    buy = (buyOrders || []).map((o) => normalise(o, "buy"));
  } else if (groupedSell && groupedBuy) {
    // possible grouped shape: { sell: [], buy: [] }
    sell = groupedSell.map((o) => normalise(o, "sell"));
    buy = groupedBuy.map((o) => normalise(o, "buy"));
  } else if (Array.isArray(ordersList)) {
    sell = ordersList.filter((o) => getType(o) === "sell").map((o) => normalise(o));
    buy = ordersList.filter((o) => getType(o) === "buy").map((o) => normalise(o));
  } else if (Array.isArray(payload)) {
    const arr = payload as WfmRawOrder[];
    sell = arr.filter((o) => getType(o) === "sell").map((o) => normalise(o));
    buy = arr.filter((o) => getType(o) === "buy").map((o) => normalise(o));
  } else {
    log.log("[WFMOrders] Unknown response shape. Top-level keys:", Object.keys((data as object) || {}));
    if (payload && typeof payload === "object") {
      log.log("[WFMOrders] Payload keys:", Object.keys(payload as object));
    }
    sell = [];
    buy = [];
  }
  return { sell, buy };
}


/**
 * Fetch the current user's orders.
 * Returns { sell: Order[], buy: Order[] }
 */
export async function getMyOrders(): Promise<{ sell: NormalisedOrder[]; buy: NormalisedOrder[] }> {
  if (!getInGameName()) throw new Error("Not logged in to Warframe.market.");

  // GET /v2/orders/my — documented WFM v2 endpoint for the authenticated user's own orders.
  log.log("[WFMOrders] \u2192 GET /v2/orders/my (auth)");
  const data = await requestV2("GET", "/orders/my");
  const unwrapped = unwrapWfmResponse<WfmRawOrder[]>(data);
  const rawOrders: WfmRawOrder[] = Array.isArray(unwrapped) ? unwrapped : [];
  log.log(`[WFMOrders] raw order count: ${rawOrders.length}`);

  // v2 orders have only itemId (string). Enrich each order with catalog item details
  // so normalise() has access to item name, url_name, and thumb.
  const enriched = await Promise.all(
    rawOrders.map(async (order) => {
      if (!order.item && order.itemId) {
        const catalogItem = await wfmCatalog.lookupById(order.itemId);
        if (catalogItem) return { ...order, _catalogItem: catalogItem } as WfmRawOrder;
      }
      return order;
    }),
  );

  const { sell, buy } = _extractOrders({ data: enriched });
  log.log(`[WFMOrders] \u2713 sell: ${sell.length}, buy: ${buy.length}`);
  return { sell, buy };
}

export async function createOrder({
  itemId,
  orderType,
  platinum,
  quantity,
  visible = true,
  modRank,
}: {
  itemId: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible?: boolean;
  modRank?: number | null;
}): Promise<NormalisedOrder> {
  if (!itemId || !orderType || platinum == null || quantity == null) {
    throw new Error("createOrder: itemId, orderType, platinum, and quantity are required.");
  }
  const body: Record<string, unknown> = {
    // v2 field names (camelCase, not snake_case like v1)
    itemId,
    type: orderType,
    platinum: Number(platinum),
    quantity: Number(quantity),
    visible: !!visible,
  };
  if (modRank != null) body.rank = Number(modRank); // v2: 'rank' not 'mod_rank'

  // v2: POST /order
  const data = await requestV2("POST", "/order", { json: body });
  const unwrapped = unwrapWfmResponse<WfmOrderMutationData>(data);
  const raw = (unwrapped?.order || unwrapped || data) as WfmRawOrder;
  return normalise(raw);
}

export async function updateOrder(
  orderId: string,
  {
    platinum,
    quantity,
    visible,
    modRank,
  }: { platinum?: number; quantity?: number; visible?: boolean; modRank?: number | null } = {},
): Promise<NormalisedOrder> {
  if (!orderId) throw new Error("updateOrder: orderId is required.");
  const body: Record<string, unknown> = {};
  if (platinum != null) body.platinum = Number(platinum);
  if (quantity != null) body.quantity = Number(quantity);
  if (visible != null) body.visible = !!visible;
  if (modRank != null) body.rank = Number(modRank); // v2: 'rank' not 'mod_rank'
  if (Object.keys(body).length === 0) throw new Error("updateOrder: no fields to update.");

  // v2: PATCH /order/{id}  (WFM changed PUT → PATCH)
  const data = await requestV2("PATCH", `/order/${encodeURIComponent(orderId)}`, { json: body });
  const unwrapped = unwrapWfmResponse<WfmOrderMutationData>(data);
  const raw = (unwrapped?.order || unwrapped || data) as WfmRawOrder;
  return normalise(raw);
}

export async function deleteOrder(orderId: string): Promise<{ deleted: boolean; id: string }> {
  if (!orderId) throw new Error("deleteOrder: orderId is required.");
  // v2: DELETE /order/{id}
  await requestV2("DELETE", `/order/${encodeURIComponent(orderId)}`);
  return { deleted: true, id: orderId };
}

/**
 * Close (mark as sold/bought) an order by decrementing its quantity.
 * Uses `POST /v2/order/{id}/close` with `{ quantity }`.
 * When the remaining quantity reaches 0, WFM removes the listing automatically.
 */
export async function closeOrder(
  orderId: string,
  quantity: number,
): Promise<WfmCloseOrderResult> {
  if (!orderId) throw new Error("closeOrder: orderId is required.");
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("closeOrder: quantity must be a positive integer.");
  }

  log.log(`[WFMOrders] → POST /v2/order/${orderId}/close  qty=${quantity}`);
  await requestV2("POST", `/order/${encodeURIComponent(orderId)}/close`, {
    json: { quantity },
  });

  // The API does not return the remaining quantity, so we report 0 as unknown.
  // Callers should re-fetch orders to get the updated state.
  return { closed: true, id: orderId, remainingQuantity: 0 };
}

export async function setOrdersVisible(
  orderIds: string[],
  visible: boolean,
): Promise<Array<NormalisedOrder | { id: string; error: string }>> {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
  const results: Array<NormalisedOrder | { id: string; error: string }> = [];
  for (const id of orderIds) {
    try {
      const updated = await updateOrder(id, { visible: !!visible });
      results.push(updated);
    } catch (err) {
      log.error(`[WFMOrders] setVisible failed for ${id}:`, normalizeErrorMessage(err));
      results.push({ id, error: normalizeErrorMessage(err) });
    }
  }
  return results;
}
