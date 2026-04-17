/**
 * tradeWfmMatcher.ts — Matches completed in-game trades to the user's
 * active WFM orders and closes the best match.
 *
 * Algorithm modeled after AlecaFrame's WFMarketHelper.ItemsWereJustTraded():
 *   1. Fetch user's active orders
 *   2. Filter by direction (sell orders for sales, buy orders for purchases)
 *   3. Match by item name (Blueprint-insensitive, case-insensitive)
 *   4. Tiebreak: plat proximity → mod rank proximity → quantity
 *   5. Close the best match via POST /v2/order/{id}/close
 */

import { withScope } from "./logger";
import * as wfmOrders from "./wfmOrders";
import type { NormalisedOrder } from "./wfmOrders";
import * as wfmSession from "./wfmSession";
import * as wfmCatalog from "./wfmCatalog";
import type { TradeType, TradeDirection } from "../config/shared/statsTypes";

const log = withScope("tradeWfmMatcher");

export interface ParsedTradeForMatching {
  partner: string;
  platChange: number;
  type: TradeType;
  items: Array<{ displayName: string; count: number; direction: TradeDirection }>;
}

export interface WfmTradeMatch {
  orderId: string;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
  quantity: number;
  platinum: number;
  partner: string;
  type: TradeType;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** AlecaFrame caps quantity at 6 per close */
const MAX_CLOSE_QUANTITY = 6;

/** Prevent double-close on the same order within a short window */
const _recentlyClosedOrders = new Map<string, number>();
const CLOSE_DEDUP_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.replace(/ Blueprint$/i, "").trim().toLowerCase();
}

function cleanupRecentlyClosed(): void {
  const now = Date.now();
  for (const [id, ts] of _recentlyClosedOrders) {
    if (now - ts > CLOSE_DEDUP_MS) _recentlyClosedOrders.delete(id);
  }
}

// ── Core matcher ──────────────────────────────────────────────────────────────

/**
 * Attempt to match a completed trade against the user's active WFM orders.
 * Returns the matched order info, or null if no match found.
 */
export async function matchTradeToOrder(
  trade: ParsedTradeForMatching,
): Promise<WfmTradeMatch | null> {
  // Guard: must be logged in to WFM
  if (!wfmSession.getToken()) {
    log.log("[Matcher] Skipping — not logged in to WFM");
    return null;
  }

  // Determine which items to match:
  // For sales, we match items we GAVE (the buyer receives them)
  // For purchases, we match items we RECEIVED
  const relevantItems = trade.items.filter((i) =>
    trade.type === "sale" ? i.direction === "given" : i.direction === "received",
  );

  if (relevantItems.length === 0) {
    log.log("[Matcher] No relevant items to match");
    return null;
  }

  // Fetch user's current orders
  let orders: { sell: NormalisedOrder[]; buy: NormalisedOrder[] };
  try {
    orders = await wfmOrders.getMyOrders();
  } catch (err) {
    log.warn("[Matcher] Failed to fetch orders:", String(err));
    return null;
  }

  const candidateOrders = trade.type === "sale" ? orders.sell : orders.buy;
  if (candidateOrders.length === 0) {
    log.log(`[Matcher] No ${trade.type === "sale" ? "sell" : "buy"} orders to match against`);
    return null;
  }

  cleanupRecentlyClosed();

  // Try to match each traded item against an order
  // For simplicity, match the first item that resolves (like AlecaFrame's single-item path)
  for (const item of relevantItems) {
    const normalizedItem = normalizeName(item.displayName);
    if (!normalizedItem) continue;

    // Also try catalog lookup to get the canonical WFM item name
    const catalogItem = wfmCatalog.lookupByName(item.displayName)
      || wfmCatalog.lookupByName(item.displayName.replace(/ Blueprint$/i, ""));

    // Filter orders that match this item by name
    const matching = candidateOrders.filter((order: NormalisedOrder) => {
      if (_recentlyClosedOrders.has(order.id)) return false;

      const orderItemName = normalizeName(String(order.itemName || ""));
      if (orderItemName === normalizedItem) return true;

      // Also try matching via url_name if we resolved the catalog
      if (catalogItem?.url_name && order.itemUrlName === catalogItem.url_name) return true;

      return false;
    });

    if (matching.length === 0) continue;

    // Sort by AlecaFrame's tiebreaker: plat proximity → rank proximity → quantity
    matching.sort((a: NormalisedOrder, b: NormalisedOrder) => {
      const platDiffA = Math.abs((a.platinum || 0) - trade.platChange);
      const platDiffB = Math.abs((b.platinum || 0) - trade.platChange);
      if (platDiffA !== platDiffB) return platDiffA - platDiffB;

      // Rank proximity (lower is better, null ranks sort last)
      const rankA = a.modRank ?? -1;
      const rankB = b.modRank ?? -1;
      if (rankA !== rankB) return rankA - rankB;

      // Quantity (lower is better)
      return (a.quantity || 1) - (b.quantity || 1);
    });

    const bestMatch = matching[0];
    const closeQty = Math.min(item.count, bestMatch.quantity || 1, MAX_CLOSE_QUANTITY);

    return {
      orderId: bestMatch.id,
      itemName: bestMatch.itemName || item.displayName,
      itemUrlName: bestMatch.itemUrlName || catalogItem?.url_name || null,
      itemThumb: bestMatch.itemThumb || null,
      quantity: closeQty,
      platinum: bestMatch.platinum || 0,
      partner: trade.partner,
      type: trade.type,
    };
  }

  log.log("[Matcher] No matching WFM orders found for traded items");
  return null;
}

/**
 * Close the matched WFM order and mark it as recently closed to prevent duplicates.
 */
export async function closeMatchedOrder(match: WfmTradeMatch): Promise<boolean> {
  try {
    log.log(
      `[Matcher] Closing order ${match.orderId} (${match.itemName}) qty=${match.quantity}`,
    );
    await wfmOrders.closeOrder(match.orderId, match.quantity);
    _recentlyClosedOrders.set(match.orderId, Date.now());
    log.log(`[Matcher] ✓ Order ${match.orderId} closed successfully`);
    return true;
  } catch (err) {
    log.warn(`[Matcher] Failed to close order ${match.orderId}:`, String(err));
    return false;
  }
}
