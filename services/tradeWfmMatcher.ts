import { withScope } from "./logger";
import * as wfmOrders from "./wfmOrders";
import type { NormalisedOrder } from "./wfmOrders";
import * as wfmSession from "./wfmSession";
import * as wfmCatalog from "./wfmCatalog";
import * as wfmContracts from "./wfmContracts";
import { lookupTradedCatalogItem } from "./tradeItemName";
import { parseTradedItemName } from "../config/shared/tradeItemName";
import { normalizeForSearch, normalizeForSlug } from "../config/shared/textNormalize";
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

const _recentlyClosedOrders = new Map<string, number>();
const CLOSE_DEDUP_MS = 30_000;
const CONTRACT_PAGE_LIMIT = 100;

function normalizeName(name: string): string {
  return normalizeForSearch(name.replace(/ Blueprint$/i, ""));
}

interface PreparedTradeItem {
  item: ParsedTradeForMatching["items"][number];
  parsed: ReturnType<typeof parseTradedItemName>;
  slug: string | null;
  remaining: number;
}

function closeableQuantity(order: NormalisedOrder, tradedQuantity: number): number {
  const available = Math.min(tradedQuantity, order.quantity || 1);
  const perTrade = Math.max(1, order.perTrade ?? 1);
  return available % perTrade === 0 ? available : 0;
}

async function matchesTradeRank(order: NormalisedOrder, rank: number): Promise<boolean> {
  if (order.modRank === rank) return true;
  if (rank !== 0 || order.modRank !== null || !order.itemId || !order.itemUrlName) return false;

  try {
    // Rankless mods still log RANK 0.
    const details = await wfmCatalog.lookupItemDetails(order.itemUrlName);
    return (
      details?.id === order.itemId &&
      details.url_name === order.itemUrlName &&
      details.hasRanks === false
    );
  } catch (err) {
    log.warn("[Matcher] Could not verify the item's rank policy:", String(err));
    return false;
  }
}

function cleanupRecentlyClosed(): void {
  const now = Date.now();
  for (const [id, ts] of _recentlyClosedOrders) {
    if (now - ts > CLOSE_DEDUP_MS) _recentlyClosedOrders.delete(id);
  }
}

export async function matchTradeToOrders(trade: ParsedTradeForMatching): Promise<WfmTradeMatch[]> {
  if (!wfmSession.getToken()) {
    log.info("[Matcher] Skipping - not logged in to WFM");
    return [];
  }

  const relevantItems = trade.items.filter((i) =>
    trade.type === "sale" ? i.direction === "given" : i.direction === "received",
  );

  if (relevantItems.length === 0) {
    log.info("[Matcher] No relevant items to match");
    return [];
  }

  cleanupRecentlyClosed();

  const matches: WfmTradeMatch[] = [];
  const usedOrderIds = new Set<string>();
  const preparedItems: PreparedTradeItem[] = [];
  for (const item of relevantItems) {
    const parsed = parseTradedItemName(item.displayName);
    const existing = !parsed.riven
      ? preparedItems.find((prepared) => prepared.item.displayName === item.displayName)
      : undefined;
    if (existing) {
      existing.remaining += item.count;
      continue;
    }
    const catalogItem = lookupTradedCatalogItem(item.displayName);
    preparedItems.push({
      item,
      parsed,
      slug: catalogItem?.url_name ?? null,
      remaining: item.count,
    });
  }

  matches.push(...(await matchRivenContracts(preparedItems, trade)));

  let orders: { sell: NormalisedOrder[]; buy: NormalisedOrder[] };
  try {
    orders = await wfmOrders.getMyOrders();
  } catch (err) {
    log.warn("[Matcher] Failed to fetch orders:", String(err));
    return matches;
  }

  const candidateOrders = trade.type === "sale" ? orders.sell : orders.buy;
  if (candidateOrders.length === 0) {
    log.info(`[Matcher] No ${trade.type === "sale" ? "sell" : "buy"} orders to match against`);
    return matches;
  }

  const tradedCounts = new Map<string, number>();
  for (const item of preparedItems) {
    if (!item.slug || item.remaining < 1) continue;
    tradedCounts.set(item.slug, (tradedCounts.get(item.slug) || 0) + item.remaining);
  }
  const setResult = await matchSetOrders(candidateOrders, tradedCounts, trade);
  matches.push(...setResult.matches);
  for (const match of setResult.matches) usedOrderIds.add(match.orderId);
  for (const [slug, consumed] of setResult.consumedCounts) {
    let remainingToConsume = consumed;
    for (const item of preparedItems) {
      if (item.slug !== slug || remainingToConsume < 1) continue;
      const used = Math.min(item.remaining, remainingToConsume);
      item.remaining -= used;
      remainingToConsume -= used;
    }
  }

  for (const prepared of preparedItems) {
    if (prepared.remaining < 1) continue;
    const normalizedItem = normalizeName(prepared.parsed.baseName);
    if (!normalizedItem) continue;

    let matching = candidateOrders.filter((order: NormalisedOrder) => {
      if (_recentlyClosedOrders.has(order.id) || usedOrderIds.has(order.id)) return false;

      const orderItemName = normalizeName(String(order.itemName || ""));
      if (orderItemName === normalizedItem) return true;
      if (prepared.slug && order.itemUrlName === prepared.slug) return true;

      return false;
    });

    if (prepared.parsed.rank != null) {
      const rank = prepared.parsed.rank;
      const rankMatches = await Promise.all(matching.map((order) => matchesTradeRank(order, rank)));
      matching = matching.filter((_, index) => rankMatches[index]);
    }
    if (matching.length === 0) continue;

    matching.sort((a: NormalisedOrder, b: NormalisedOrder) => {
      if (relevantItems.length === 1) {
        const platDiffA = Math.abs((a.platinum || 0) - trade.platChange);
        const platDiffB = Math.abs((b.platinum || 0) - trade.platChange);
        if (platDiffA !== platDiffB) return platDiffA - platDiffB;
      }
      return (a.quantity || 1) - (b.quantity || 1);
    });

    for (const order of matching) {
      if (prepared.remaining < 1) break;
      const closeQty = closeableQuantity(order, prepared.remaining);
      if (closeQty < 1) {
        log.warn(`[Matcher] Order ${order.id} cannot close ${prepared.remaining} unit(s)`);
        continue;
      }

      usedOrderIds.add(order.id);
      prepared.remaining -= closeQty;
      matches.push({
        kind: "order",
        orderId: order.id,
        itemName: order.itemName || prepared.item.displayName,
        itemUrlName: order.itemUrlName || prepared.slug,
        itemThumb: order.itemThumb || null,
        quantity: closeQty,
        platinum: order.platinum || 0,
        partner: trade.partner,
        type: trade.type,
      });
    }
  }

  if (matches.length === 0) {
    const tradedSummary = relevantItems
      .map((item) => `"${item.displayName}" x${item.count}`)
      .join(", ");
    log.info(
      `[Matcher] No matching WFM orders found for traded items: ${tradedSummary} ` +
        `(${candidateOrders.length} ${trade.type === "sale" ? "sell" : "buy"} order(s) checked)`,
    );
  }
  return matches;
}

async function matchRivenContracts(
  items: PreparedTradeItem[],
  trade: ParsedTradeForMatching,
): Promise<WfmTradeMatch[]> {
  if (trade.type !== "sale") return [];
  const rivenItems = items.filter((item) => item.parsed.riven);
  if (rivenItems.length === 0) return [];

  let contracts: Awaited<ReturnType<typeof wfmContracts.getMyContracts>>["contracts"];
  try {
    contracts = (await wfmContracts.getMyContracts({ limit: CONTRACT_PAGE_LIMIT })).contracts;
  } catch (err) {
    log.warn("[Matcher] Failed to fetch riven auctions:", String(err));
    return [];
  }

  const matches: WfmTradeMatch[] = [];
  const usedAuctionIds = new Set<string>();
  for (const item of rivenItems) {
    const { baseName, riven } = item.parsed;
    if (!riven) continue;

    const weaponSlug = normalizeForSlug(riven.weapon);
    const sameWeapon = contracts.filter(
      (contract) =>
        !_recentlyClosedOrders.has(contract.id) &&
        !usedAuctionIds.has(contract.id) &&
        contract.weaponUrlName &&
        normalizeForSlug(contract.weaponUrlName) === weaponSlug,
    );
    const suffixSlug = normalizeForSlug(riven.suffix);
    const exact = sameWeapon.filter(
      (contract) => contract.rivenSuffix && normalizeForSlug(contract.rivenSuffix) === suffixSlug,
    );
    const best = exact[0] || (sameWeapon.length === 1 ? sameWeapon[0] : null);
    if (!best) {
      log.info(
        `[Matcher] No riven auction matched "${baseName}" (${sameWeapon.length} for weapon)`,
      );
      continue;
    }

    usedAuctionIds.add(best.id);
    item.remaining = Math.max(0, item.remaining - 1);
    matches.push({
      kind: "contract",
      orderId: best.id,
      itemName: baseName,
      itemUrlName: best.weaponUrlName,
      itemThumb: best.itemThumb,
      quantity: 1,
      platinum: rivenItems.length === 1 ? trade.platChange || best.platinum : best.platinum,
      partner: trade.partner,
      type: trade.type,
    });
  }
  return matches;
}

interface SetMatchResult {
  matches: WfmTradeMatch[];
  consumedCounts: ReadonlyMap<string, number>;
}

async function matchSetOrders(
  candidateOrders: NormalisedOrder[],
  tradedCounts: Map<string, number>,
  trade: ParsedTradeForMatching,
): Promise<SetMatchResult> {
  const noMatch: SetMatchResult = {
    matches: [],
    consumedCounts: new Map(),
  };
  if (tradedCounts.size < 2) return noMatch;

  const setOrders = new Map<string, NormalisedOrder[]>();
  for (const order of candidateOrders) {
    if (_recentlyClosedOrders.has(order.id)) continue;
    const slug = order.itemUrlName || "";
    if (!slug.endsWith("_set")) continue;
    const matchingOrders = setOrders.get(slug);
    if (matchingOrders) matchingOrders.push(order);
    else setOrders.set(slug, [order]);
  }
  if (setOrders.size === 0) return noMatch;

  const definitions = new Map<
    string,
    { kind: "set"; setSlug: string; parts: Array<{ slug: string; quantityInSet: number }> }
  >();
  for (const slug of tradedCounts.keys()) {
    const result = await wfmCatalog.resolveSetMembership(slug);
    if (result.kind === "set") {
      if (setOrders.has(result.setSlug)) definitions.set(result.setSlug, result);
    } else if (result.kind === "unavailable") {
      log.warn(`[Matcher] Set metadata unavailable for ${slug}; checking individual orders`);
    }
  }

  const availableCounts = new Map(tradedCounts);
  const consumedCounts = new Map<string, number>();
  const matches: WfmTradeMatch[] = [];
  for (const definition of definitions.values()) {
    let setsCovered = Infinity;
    for (const part of definition.parts) {
      const have = availableCounts.get(part.slug) || 0;
      setsCovered = Math.min(setsCovered, Math.floor(have / part.quantityInSet));
    }
    if (!Number.isFinite(setsCovered) || setsCovered < 1) continue;

    const orders = setOrders.get(definition.setSlug) || [];
    orders.sort((a, b) => (a.quantity || 1) - (b.quantity || 1));
    for (const order of orders) {
      if (setsCovered < 1) break;
      const closeQty = closeableQuantity(order, setsCovered);
      if (closeQty < 1) continue;

      for (const part of definition.parts) {
        const consumed = closeQty * part.quantityInSet;
        availableCounts.set(part.slug, (availableCounts.get(part.slug) || 0) - consumed);
        consumedCounts.set(part.slug, (consumedCounts.get(part.slug) || 0) + consumed);
      }
      setsCovered -= closeQty;
      matches.push({
        kind: "order",
        orderId: order.id,
        itemName: order.itemName || "(set)",
        itemUrlName: order.itemUrlName || null,
        itemThumb: order.itemThumb || null,
        quantity: closeQty,
        platinum: order.platinum || 0,
        partner: trade.partner,
        type: trade.type,
      });
    }
  }

  return { matches, consumedCounts };
}

/** Closes a match once despite duplicate EE.log delivery. */
export async function closeMatchedOrder(match: WfmTradeMatch): Promise<boolean> {
  try {
    log.info(`[Matcher] Closing ${match.kind} ${match.orderId} (${match.itemName})`);
    if (match.kind === "contract") await wfmContracts.closeContract(match.orderId);
    else await wfmOrders.closeOrder(match.orderId, match.quantity);
    _recentlyClosedOrders.set(match.orderId, Date.now());
    log.info(`[Matcher] ${match.kind} ${match.orderId} closed successfully`);
    return true;
  } catch (err) {
    log.warn(`[Matcher] Failed to close order ${match.orderId}:`, String(err));
    return false;
  }
}
