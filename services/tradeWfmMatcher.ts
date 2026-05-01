/**
 * tradeWfmMatcher.ts — Matches completed in-game trades to the user's
 * active WFM orders and closes the best match.
 *
 * Matches a completed in-game trade to the user's active WFM orders:
 *   1. Fetch active orders.
 *   2. Filter by direction.
 *   3. Match by item name.
 *   4. Tiebreak by platinum proximity, mod rank proximity, then quantity.
 *   5. Close the best matching order.
 */

import { withScope } from "./logger";
import * as wfmOrders from "./wfmOrders";
import type { NormalisedOrder } from "./wfmOrders";
import * as wfmSession from "./wfmSession";
import * as wfmCatalog from "./wfmCatalog";
import { normalizeForSearch } from "../config/shared/textNormalize";
import type { TradeType, TradeDirection } from "../config/shared/statsTypes";
import type { TradeMatchPayload } from "../config/shared/tradeMatch";

const log = withScope("tradeWfmMatcher");

interface ParsedTradeForMatching {
  partner: string;
  platChange: number;
  type: TradeType;
  items: Array<{ displayName: string; count: number; direction: TradeDirection }>;
}

type WfmTradeMatch = TradeMatchPayload;


/** Cap quantity closed from a single trade match. */
const MAX_CLOSE_QUANTITY = 6;

/** Prevent double-close on the same order within a short window */
const _recentlyClosedOrders = new Map<string, number>();
const CLOSE_DEDUP_MS = 30_000;


function normalizeName(name: string): string {
  return normalizeForSearch(name.replace(/ Blueprint$/i, ""));
}

function cleanupRecentlyClosed(): void {
  const now = Date.now();
  for (const [id, ts] of _recentlyClosedOrders) {
    if (now - ts > CLOSE_DEDUP_MS) _recentlyClosedOrders.delete(id);
  }
}


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

  // Match the first traded item that resolves to an active order.
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

    // Sort by platinum proximity, rank proximity, then quantity.
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
