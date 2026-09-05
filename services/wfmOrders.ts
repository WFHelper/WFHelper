import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { SUBTYPE_REQUIRED_CODE } from "../config/shared/wfmOrders";

import { requestV2 } from "./wfmClient";
import { getInGameName } from "./wfmSession";
import * as wfmCatalog from "./wfmCatalog";
import type {
  WfmRawOrder,
  WfmRawOrderItem,
  WfmOrderMutationData,
  WfmCloseOrderResult,
} from "./wfmTypes";
import { unwrapWfmResponse, WfmApiError } from "./wfmTypes";

import { formatWfmAssetUrl } from "../config/shared/wfm";

export interface NormalisedOrder {
  id: string;
  orderType: string;
  platinum: number;
  quantity: number;
  perTrade?: number;
  visible: boolean;
  modRank: number | null;
  subtype: string | null;
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

  const quantity = Number.isInteger(raw.quantity) && raw.quantity > 0 ? raw.quantity : 1;
  const perTradeRaw = raw.perTrade ?? raw.per_trade ?? 1;
  const perTrade =
    Number.isInteger(perTradeRaw) && perTradeRaw > 0 ? Math.min(perTradeRaw, quantity) : 1;

  return {
    id: raw.id,
    // v2 uses 'type', v1 used 'order_type'
    orderType: raw.type || raw.order_type || forcedType || "sell",
    platinum: raw.platinum ?? 0,
    quantity,
    perTrade,
    visible: raw.visible ?? true,
    // v2 uses 'rank', v1 used 'mod_rank'
    modRank: raw.rank ?? raw.mod_rank ?? null,
    subtype: typeof raw.subtype === "string" && raw.subtype ? raw.subtype : null,
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
    log.info(
      "[WFMOrders] Unknown response shape. Top-level keys:",
      Object.keys((data as object) || {}),
    );
    if (payload && typeof payload === "object") {
      log.info("[WFMOrders] Payload keys:", Object.keys(payload as object));
    }
    sell = [];
    buy = [];
  }
  return { sell, buy };
}

export async function getMyOrders(): Promise<{ sell: NormalisedOrder[]; buy: NormalisedOrder[] }> {
  if (!getInGameName()) throw new Error("Not logged in to Warframe.market.");

  // GET /v2/orders/my - documented WFM v2 endpoint for the authenticated user's own orders.
  log.info("[WFMOrders] -> GET /v2/orders/my (auth)");
  const data = await requestV2("GET", "/orders/my");
  const unwrapped = unwrapWfmResponse<WfmRawOrder[]>(data);
  const rawOrders: WfmRawOrder[] = Array.isArray(unwrapped) ? unwrapped : [];
  log.info(`[WFMOrders] raw order count: ${rawOrders.length}`);

  // v2 orders have only itemId (string). Enrich each order with catalog item details
  // so normalise() has access to item name, url_name, and thumb.
  const enriched = await Promise.all(
    rawOrders.map(async (order) => {
      if (!order.item && order.itemId) {
        try {
          const catalogItem = await wfmCatalog.lookupById(order.itemId);
          if (catalogItem) return { ...order, _catalogItem: catalogItem } as WfmRawOrder;
        } catch {
          // Catalog unavailable: keep the raw order so the list still renders.
        }
      }
      return order;
    }),
  );

  const { sell, buy } = _extractOrders({ data: enriched });
  log.info(`[WFMOrders] ok - sell: ${sell.length}, buy: ${buy.length}`);
  return { sell, buy };
}

// api 0.25 rejects perTrade; 0.24 required it. Remember which shape the server
// accepts and retry once on the opposite 400.
let _sendPerTrade = false;

/** The item is sold per subtype and the caller chose none. Carries the API's
 *  list so the caller can ask; picking one here would list the item under a
 *  variant the user never selected. */
class WfmSubtypeRequiredError extends WfmApiError {
  readonly subtypes: readonly string[];
  constructor(subtypes: readonly string[]) {
    super(
      `warframe.market needs a subtype for this item: ${subtypes.join(", ")}`,
      SUBTYPE_REQUIRED_CODE,
      400,
    );
    this.name = "WfmSubtypeRequiredError";
    this.subtypes = subtypes;
  }
}

// Atragraph mod variants gave plain mods a subtypes list, and v2 rejects a
// bare create on any subtyped item ("subtype: app.field.required"). The local
// catalog carries no subtypes, so ask the API which ones the item has.
async function resolveSubtypeChoices(itemId: string): Promise<string[]> {
  try {
    const entry = await wfmCatalog.lookupById(itemId);
    if (!entry || !entry.url_name) return [];
    const data = await requestV2("GET", `/item/${encodeURIComponent(entry.url_name)}`);
    const unwrapped = unwrapWfmResponse<{ subtypes?: unknown }>(data);
    return Array.isArray(unwrapped?.subtypes)
      ? unwrapped.subtypes.filter((s): s is string => typeof s === "string")
      : [];
  } catch (err) {
    log.warn("[WFMOrders] subtype lookup failed:", normalizeErrorMessage(err));
    return [];
  }
}

export function __resetWfmOrdersForTest(): void {
  _sendPerTrade = false;
}

export async function createOrder({
  itemId,
  orderType,
  platinum,
  quantity,
  visible = true,
  modRank,
  perTrade,
  subtype,
}: {
  itemId: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible?: boolean;
  modRank?: number | null;
  perTrade?: number | null;
  subtype?: string | null;
}): Promise<NormalisedOrder> {
  if (!itemId || !orderType || platinum == null || quantity == null) {
    throw new Error("createOrder: itemId, orderType, platinum, and quantity are required.");
  }
  const qty = Number(quantity);
  const buildBody = (sendPerTrade: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      // v2 field names (camelCase, not snake_case like v1)
      itemId,
      type: orderType,
      platinum: Number(platinum),
      quantity: qty,
      visible: !!visible,
    };
    if (sendPerTrade) {
      // perTrade = max units per in-game trade, clamped to [1, quantity].
      body.perTrade = Math.min(Math.max(1, Math.floor(Number(perTrade) || 1)), Math.max(1, qty));
    }
    if (modRank != null) body.rank = Number(modRank); // v2: 'rank' not 'mod_rank'
    if (subtype != null) body.subtype = String(subtype);
    return body;
  };

  // Each compatibility retry applies once.
  let sendPerTrade = _sendPerTrade;
  let perTradeFlipped = false;
  let subtypeResolved = false;
  let data: unknown;
  for (;;) {
    try {
      data = await requestV2("POST", "/order", { json: buildBody(sendPerTrade) });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wantsFlip = sendPerTrade ? /notAllowed/i : /required/i;
      if (!perTradeFlipped && /perTrade/i.test(message) && wantsFlip.test(message)) {
        perTradeFlipped = true;
        sendPerTrade = !sendPerTrade;
        _sendPerTrade = sendPerTrade;
        log.info(
          `[WFMOrders] server ${sendPerTrade ? "requires" : "rejects"} perTrade - retrying ${
            sendPerTrade ? "with" : "without"
          } it`,
        );
        continue;
      }
      if (modRank == null && /\brank\b/i.test(message) && /required/i.test(message)) {
        // Stale catalog entries can omit the required rank.
        modRank = 0;
        log.info("[WFMOrders] server requires rank - retrying with rank 0");
        continue;
      }
      if (
        subtype == null &&
        !subtypeResolved &&
        /subtype/i.test(message) &&
        /required/i.test(message)
      ) {
        subtypeResolved = true;
        const choices = await resolveSubtypeChoices(itemId);
        // "regular" is the plain item, so it is the only safe automatic pick.
        if (choices.includes("regular")) {
          subtype = "regular";
          log.info('[WFMOrders] server requires subtype - retrying with "regular"');
          continue;
        }
        if (choices.length > 0) throw new WfmSubtypeRequiredError(choices);
      }
      throw err;
    }
  }
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
    subtype,
  }: {
    platinum?: number;
    quantity?: number;
    visible?: boolean;
    modRank?: number | null;
    subtype?: string | null;
  } = {},
): Promise<NormalisedOrder> {
  if (!orderId) throw new Error("updateOrder: orderId is required.");
  const body: Record<string, unknown> = {};
  if (platinum != null) body.platinum = Number(platinum);
  if (quantity != null) body.quantity = Number(quantity);
  if (visible != null) body.visible = !!visible;
  if (modRank != null) body.rank = Number(modRank); // v2: 'rank' not 'mod_rank'
  if (subtype != null) body.subtype = String(subtype);
  if (Object.keys(body).length === 0) throw new Error("updateOrder: no fields to update.");

  const data = await requestV2("PATCH", `/order/${encodeURIComponent(orderId)}`, { json: body });
  const unwrapped = unwrapWfmResponse<WfmOrderMutationData>(data);
  const raw = (unwrapped?.order || unwrapped || data) as WfmRawOrder;
  return normalise(raw);
}

export async function deleteOrder(orderId: string): Promise<{ deleted: boolean; id: string }> {
  if (!orderId) throw new Error("deleteOrder: orderId is required.");
  await requestV2("DELETE", `/order/${encodeURIComponent(orderId)}`);
  return { deleted: true, id: orderId };
}

export async function closeOrder(orderId: string, quantity: number): Promise<WfmCloseOrderResult> {
  if (!orderId) throw new Error("closeOrder: orderId is required.");
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("closeOrder: quantity must be a positive integer.");
  }

  log.info(`[WFMOrders] -> POST /v2/order/${orderId}/close  qty=${quantity}`);
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
