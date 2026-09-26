import { toFinitePositiveInt } from "./numeric";

export const WFM_ORDER_SUBTYPES = ["intact", "exceptional", "flawless", "radiant"] as const;
export const WFM_MOD_VARIANTS = ["regular", "atragraph"] as const;
export type WfmOrderSubtype = (typeof WFM_ORDER_SUBTYPES)[number];

const WFM_ORDER_SUBTYPE_SET = new Set<string>(WFM_ORDER_SUBTYPES);

export function parseWfmOrderSubtype(value: unknown): WfmOrderSubtype | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return WFM_ORDER_SUBTYPE_SET.has(normalized) ? (normalized as WfmOrderSubtype) : null;
}

/** WFM leaves the default subtype unset; both spellings mean the same thing. */
export function normalizeSubtype(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return !trimmed || trimmed === "regular" ? null : trimmed;
}

export interface UnitPricedListing {
  /** Price of ONE trade, exactly as WFM lists it. A bulk order hands over
   *  `perTrade` items for it, so only `unitPlatinum` compares across orders. */
  platinum: number;
  unitPlatinum?: number;
}

export interface WfmOrderBookEntry extends UnitPricedListing {
  userName: string;
  status: string | null;
  quantity: number;
  perTrade: number;
  unitPlatinum: number;
  rank: number | null;
  avatar: string | null;
  /** Socketed Ayatan stars; only sculpture orders carry them. */
  amberStars?: number;
  cyanStars?: number;
}

type WfmOrderType = "sell" | "buy";

interface WfmOrderPriceEntry extends UnitPricedListing {
  status: string | null;
}

const MAX_ORDER_BOOK_ENTRIES_PER_SIDE = 500;

/** Lowercased order side; v1 spells it `order_type`, v2 `type`. */
export function parseOrderType(order: Record<string, unknown>): WfmOrderType | null {
  const typeV1 = typeof order.order_type === "string" ? order.order_type.toLowerCase() : "";
  if (typeV1 === "sell" || typeV1 === "buy") return typeV1;
  const typeV2 = typeof order.type === "string" ? order.type.toLowerCase() : "";
  if (typeV2 === "sell" || typeV2 === "buy") return typeV2;
  return null;
}

/** Seller name exactly as WFM spells it: it is shown to the user, so only the
 *  surrounding whitespace goes. Empty when the row names nobody. */
export function parseOrderUserName(order: Record<string, unknown>): string {
  const user = order.user as Record<string, unknown> | undefined;
  if (!user) return "";
  const nameV1 = typeof user.ingame_name === "string" ? user.ingame_name.trim() : "";
  if (nameV1) return nameV1;
  const nameV2 = typeof user.ingameName === "string" ? user.ingameName.trim() : "";
  return nameV2;
}

/** Lowercased seller platform: v2 keeps it under `user`, v1 at the top level.
 *  Null means the row does not say, which callers must not read as "not pc". */
export function parseOrderPlatform(order: Record<string, unknown>): string | null {
  const user = order.user as Record<string, unknown> | undefined;
  const fromUser = typeof user?.platform === "string" ? user.platform.trim().toLowerCase() : "";
  if (fromUser) return fromUser;
  const topLevel = typeof order.platform === "string" ? order.platform.trim().toLowerCase() : "";
  return topLevel || null;
}

export function parseOrderStatus(order: Record<string, unknown>): string | null {
  const user = order.user as Record<string, unknown> | undefined;
  return typeof user?.status === "string" ? user.status.toLowerCase() : null;
}

function parseOrderAvatar(order: Record<string, unknown>): string | null {
  const user = order.user as Record<string, unknown> | undefined;
  return typeof user?.avatar === "string" && user.avatar.trim() ? user.avatar.trim() : null;
}

export function isActiveOrderStatus(status: string | null): boolean {
  return status === "ingame" || status === "online";
}

/** Per-item price of a bulk order, kept to two decimals like WFM's own site. */
function unitPlatinumOf(platinum: number, perTrade: number): number {
  return Math.round((platinum / perTrade) * 100) / 100;
}

/** Items a bulk order hands over per trade: v2 spells it `perTrade`, v1
 *  `per_trade`. warframe.market clamps it into [1, quantity], so pass the
 *  listing's own quantity wherever that clamp is part of the contract. */
export function normalizePerTrade(value: unknown, quantity?: number): number {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed <= 0) return 1;
  const cap = toFinitePositiveInt(quantity);
  return cap == null ? parsed : Math.min(parsed, cap);
}

export function formatUnitPlatinum(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "");
}

export function listingUnitPrice(listing: UnitPricedListing): number {
  const unit = listing.unitPlatinum;
  return typeof unit === "number" && Number.isFinite(unit) && unit > 0 ? unit : listing.platinum;
}

export function bestOrderPrice(
  entries: WfmOrderPriceEntry[],
  orderType: WfmOrderType,
  activeOnly: boolean,
): number | null {
  const list = activeOnly ? entries.filter((entry) => isActiveOrderStatus(entry.status)) : entries;
  if (list.length === 0) return null;
  const prices = list.map(listingUnitPrice);
  const best = orderType === "sell" ? Math.min(...prices) : Math.max(...prices);
  return Math.max(1, Math.round(best));
}

function parseOrderRank(order: Record<string, unknown>): number | null {
  const rankRaw =
    typeof order.rank === "number"
      ? order.rank
      : typeof order.mod_rank === "number"
        ? order.mod_rank
        : null;
  if (rankRaw == null || !Number.isFinite(rankRaw) || rankRaw < 0) return null;
  return Math.floor(rankRaw);
}

function parseStarCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function extractWfmOrderList(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const jsonPayload = payload as {
    payload?: { orders?: unknown };
    data?: { orders?: unknown } | unknown[];
    orders?: unknown;
  };

  if (Array.isArray(jsonPayload.data)) return jsonPayload.data;
  if (Array.isArray(jsonPayload.payload?.orders)) return jsonPayload.payload.orders;
  if (jsonPayload.data && typeof jsonPayload.data === "object") {
    const maybeData = jsonPayload.data as { orders?: unknown };
    if (Array.isArray(maybeData.orders)) return maybeData.orders;
  }
  if (Array.isArray(jsonPayload.orders)) return jsonPayload.orders;
  return null;
}

export function normalizeWfmOrderBookSide(
  rawOrders: unknown,
  orderType: WfmOrderType,
  rankFilter: number | null,
  limit: number = MAX_ORDER_BOOK_ENTRIES_PER_SIDE,
  subtypeFilter: string | null = null,
): WfmOrderBookEntry[] {
  if (!Array.isArray(rawOrders)) return [];

  const entries = rawOrders
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const order = raw as Record<string, unknown>;

      const side = parseOrderType(order);
      if (side !== orderType) return null;
      if (order.visible === false) return null;

      const rank = parseOrderRank(order);
      if (rankFilter != null && rank !== rankFilter) return null;

      // Ordinary price views must not include cosmetic mod variants.
      if (
        subtypeFilter == null &&
        normalizeSubtype(typeof order.subtype === "string" ? order.subtype : null) === "atragraph"
      )
        return null;

      // Relic orders carry a refinement subtype; a filtered book only shows
      // orders for that refinement (missing subtype counts as intact).
      if (subtypeFilter != null) {
        const subtype =
          typeof order.subtype === "string" && order.subtype
            ? order.subtype.toLowerCase()
            : "intact";
        if (subtype !== subtypeFilter.toLowerCase()) return null;
      }

      const userName = parseOrderUserName(order);
      if (!userName) return null;

      const platinumRaw = Number(order.platinum);
      if (!Number.isFinite(platinumRaw) || platinumRaw <= 0) return null;

      const quantityRaw = Number(order.quantity);
      const quantity =
        Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;

      const perTrade = normalizePerTrade(order.perTrade ?? order.per_trade, quantity);

      const platinum = Math.round(platinumRaw);
      const entry: WfmOrderBookEntry = {
        userName,
        status: parseOrderStatus(order),
        platinum,
        quantity,
        perTrade,
        unitPlatinum: unitPlatinumOf(platinum, perTrade),
        rank,
        avatar: parseOrderAvatar(order),
      };
      const amberStars = parseStarCount(order.amberStars);
      const cyanStars = parseStarCount(order.cyanStars);
      if (amberStars !== undefined) entry.amberStars = amberStars;
      if (cyanStars !== undefined) entry.cyanStars = cyanStars;
      return entry;
    })
    .filter((entry): entry is WfmOrderBookEntry => entry != null);

  entries.sort((a, b) => {
    if (a.unitPlatinum !== b.unitPlatinum) {
      return orderType === "sell"
        ? a.unitPlatinum - b.unitPlatinum
        : b.unitPlatinum - a.unitPlatinum;
    }
    if (a.quantity !== b.quantity) return b.quantity - a.quantity;
    return a.userName.localeCompare(b.userName);
  });

  return entries.slice(0, limit);
}

/** Create refused to guess a variant; the API's list rides on the error. */
export const SUBTYPE_REQUIRED_CODE = "subtype_required";

/** Structural, not instanceof: the error crosses a late-require boundary in
 *  main and an IPC hop to the renderer, so only the shape can be trusted. */
export function subtypeChoicesOf(err: unknown): readonly string[] | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { code?: unknown; subtypes?: unknown };
  if (candidate.code !== SUBTYPE_REQUIRED_CODE || !Array.isArray(candidate.subtypes)) return null;
  const choices = candidate.subtypes.filter((s): s is string => typeof s === "string");
  return choices.length > 0 ? choices : null;
}
