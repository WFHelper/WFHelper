"use strict";

const log = require("./logger").withScope("wfmOrders");

/**
 * wfmOrders.js — Warframe.market order management (main-process only)
 *
 * Provides read and CRUD operations for the authenticated user's orders.
 * All data is normalised into a renderer-friendly shape before being returned.
 */

const { requestV2 } = require("./wfmClient");
const { getInGameName } = require("./wfmSession");
const wfmCatalog = require("./wfmCatalog");

// ── Normaliser ────────────────────────────────────────────────────────────────

const WFM_THUMB_BASE = "https://warframe.market/static/assets/";

function normalise(raw, forcedType) {
  // v2: item details come from catalog enrichment (raw._catalogItem), not embedded object
  const item = raw._catalogItem || raw.item || {};
  const thumb = item.thumb || item.icon || "";
  const imageUrl = thumb ? (thumb.startsWith("http") ? thumb : WFM_THUMB_BASE + thumb) : null;

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

function _extractOrders(data) {
  // v2 wraps in { data: ... }, v1 wraps in { payload: ... }
  const payload = data?.data || data?.payload || data;
  let sell, buy;

  // Helper: works for both v2 ('type') and v1 ('order_type')
  const getType = (o) => o.type || o.order_type || "";

  if (payload?.sell_orders || payload?.buy_orders) {
    // v1 shape: { sell_orders: [], buy_orders: [] }
    sell = (payload.sell_orders || []).map((o) => normalise(o, "sell"));
    buy = (payload.buy_orders || []).map((o) => normalise(o, "buy"));
  } else if (payload?.sell && payload?.buy) {
    // possible grouped shape: { sell: [], buy: [] }
    sell = (payload.sell || []).map((o) => normalise(o, "sell"));
    buy = (payload.buy || []).map((o) => normalise(o, "buy"));
  } else if (Array.isArray(payload?.orders)) {
    sell = payload.orders.filter((o) => getType(o) === "sell").map((o) => normalise(o));
    buy = payload.orders.filter((o) => getType(o) === "buy").map((o) => normalise(o));
  } else if (Array.isArray(payload)) {
    sell = payload.filter((o) => getType(o) === "sell").map((o) => normalise(o));
    buy = payload.filter((o) => getType(o) === "buy").map((o) => normalise(o));
  } else {
    log.log("[WFMOrders] Unknown response shape. Top-level keys:", Object.keys(data || {}));
    if (payload && typeof payload === "object") {
      log.log("[WFMOrders] Payload keys:", Object.keys(payload));
    }
    sell = [];
    buy = [];
  }
  return { sell, buy };
}

// ── API wrappers ──────────────────────────────────────────────────────────────

/**
 * Fetch the current user's orders.
 * Returns { sell: Order[], buy: Order[] }
 */
async function getMyOrders() {
  if (!getInGameName()) throw new Error("Not logged in to Warframe.market.");

  // GET /v2/orders/my — documented WFM v2 endpoint for the authenticated user's own orders.
  log.log("[WFMOrders] \u2192 GET /v2/orders/my (auth)");
  const data = await requestV2("GET", "/orders/my");
  const rawOrders = Array.isArray(data?.data) ? data.data : [];
  log.log(`[WFMOrders] raw order count: ${rawOrders.length}`);

  // v2 orders have only itemId (string). Enrich each order with catalog item details
  // so normalise() has access to item name, url_name, and thumb.
  const enriched = await Promise.all(
    rawOrders.map(async (order) => {
      if (!order.item && order.itemId) {
        const catalogItem = await wfmCatalog.lookupById(order.itemId);
        if (catalogItem) return { ...order, _catalogItem: catalogItem };
      }
      return order;
    }),
  );

  const { sell, buy } = _extractOrders({ data: enriched });
  log.log(`[WFMOrders] \u2713 sell: ${sell.length}, buy: ${buy.length}`);
  return { sell, buy };
}

async function createOrder({ itemId, orderType, platinum, quantity, visible = true, modRank }) {
  if (!itemId || !orderType || platinum == null || quantity == null) {
    throw new Error("createOrder: itemId, orderType, platinum, and quantity are required.");
  }
  const body = {
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
  const raw = data?.data?.order || data?.data || data?.payload?.order || data?.order || data;
  return normalise(raw);
}

async function updateOrder(orderId, { platinum, quantity, visible, modRank } = {}) {
  if (!orderId) throw new Error("updateOrder: orderId is required.");
  const body = {};
  if (platinum != null) body.platinum = Number(platinum);
  if (quantity != null) body.quantity = Number(quantity);
  if (visible != null) body.visible = !!visible;
  if (modRank != null) body.rank = Number(modRank); // v2: 'rank' not 'mod_rank'
  if (Object.keys(body).length === 0) throw new Error("updateOrder: no fields to update.");

  // v2: PATCH /order/{id}  (WFM changed PUT → PATCH)
  const data = await requestV2("PATCH", `/order/${encodeURIComponent(orderId)}`, { json: body });
  const raw = data?.data?.order || data?.data || data?.payload?.order || data?.order || data;
  return normalise(raw);
}

async function deleteOrder(orderId) {
  if (!orderId) throw new Error("deleteOrder: orderId is required.");
  // v2: DELETE /order/{id}
  await requestV2("DELETE", `/order/${encodeURIComponent(orderId)}`);
  return { deleted: true, id: orderId };
}

async function setOrdersVisible(orderIds, visible) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return [];
  const results = [];
  for (const id of orderIds) {
    try {
      const updated = await updateOrder(id, { visible: !!visible });
      results.push(updated);
    } catch (err) {
      log.error(`[WFMOrders] setVisible failed for ${id}:`, err.message);
      results.push({ id, error: err.message });
    }
  }
  return results;
}

module.exports = { getMyOrders, createOrder, updateOrder, deleteOrder, setOrdersVisible };
