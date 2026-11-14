import type { TradeEvent, TradeType } from "./statsTypes";

export interface TradeMatchPayload {
  /** Regular market order, or a riven auction (closed through a different route). */
  kind: "order" | "contract";
  orderId: string;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
  quantity: number;
  platinum: number;
  partner: string;
  type: TradeType;
}

/** Listing closed, nothing matched, close rejected, lookup threw, or never checked. */
export type TradeNotificationStatus =
  | "closed"
  | "no-match"
  | "match-failed"
  | "close-failed"
  | "detected";

/** Toast content for however many listings one trade closed. */
export function summarizeMatches(
  matches: TradeMatchPayload[],
  trade: TradeEvent,
): TradeMatchPayload | null {
  const first = matches[0];
  if (!first) return null;
  const summary = summarizeTrade(trade);
  return {
    ...first,
    itemName: summary.itemName,
    itemUrlName: summary.itemUrlName,
    itemThumb: summary.itemThumb,
    quantity: summary.quantity,
    platinum: summary.platinum,
  };
}

export interface TradeRepOffer {
  partner: string;
  hotkey: string;
}

/** Whether warframe.market can be credited for the trade. A listing of ours proves
 *  it; for a purchase, the proof is that we checked our own orders and found none. */
function repTradeIsAttributable(
  match: TradeMatchPayload,
  status: TradeNotificationStatus,
): boolean {
  const settled = status === "closed" || status === "close-failed";
  if (match.orderId) return settled;
  // Selling through warframe.market always starts with an order of our own.
  if (match.type !== "purchase") return false;
  // "no-match" is the only status that means the orders were fetched and
  // compared: "detected" never looked and "match-failed" threw.
  return status === "no-match" && match.platinum > 0;
}

export function resolveRepOffer(
  match: TradeMatchPayload | null | undefined,
  status: TradeNotificationStatus,
  options: { enabled: boolean; hotkey: string },
): TradeRepOffer | null {
  if (!options.enabled) return null;
  const hotkey = String(options.hotkey || "").trim();
  if (!hotkey) return null;
  if (!match || !repTradeIsAttributable(match, status)) return null;
  const partner = String(match.partner || "").trim();
  if (!partner) return null;
  return { partner, hotkey };
}

function groupTradeItems<T extends { displayName: string; count: number }>(items: readonly T[]) {
  const grouped = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = item.displayName.trim().toLowerCase();
    if (key === "platinum") continue;
    const existing = grouped.get(key);
    if (existing) existing.count += item.count;
    else grouped.set(key, { item, count: item.count });
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

function formatGroups<T extends { displayName: string }>(groups: { item: T; count: number }[]) {
  const names = groups.map(({ item, count }) =>
    count > 1 ? `${count} x ${item.displayName}` : item.displayName,
  );
  if (names.length > 2) return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  return names.join(" and ") || "Trade";
}

export function formatTradeItems(items: readonly { displayName: string; count: number }[]): string {
  return formatGroups(groupTradeItems(items));
}

/** Toast content when no listing closed. */
export function summarizeTrade(trade: TradeEvent): TradeMatchPayload {
  const groups = groupTradeItems(trade.items);
  const first = groups[0];
  return {
    kind: "order",
    orderId: "",
    itemName: groups.length === 1 ? first.item.displayName : formatGroups(groups),
    itemUrlName: first?.item.wfmSlug ?? null,
    itemThumb: first?.item.wfmThumb ?? null,
    quantity: groups.length === 1 ? first.count : 1,
    platinum: trade.platChange,
    partner: trade.partner ?? "",
    type: trade.type,
  };
}
