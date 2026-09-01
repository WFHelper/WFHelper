// The relic refinements WFM prices through the order `subtype` field, and the
// only subtypes the app places or filters on. Single source for all runtimes.
export const WFM_ORDER_SUBTYPES = ["intact", "exceptional", "flawless", "radiant"] as const;
export type WfmOrderSubtype = (typeof WFM_ORDER_SUBTYPES)[number];

const WFM_ORDER_SUBTYPE_SET = new Set<string>(WFM_ORDER_SUBTYPES);

/** Case-insensitive subtype allowlist; null for anything else. */
export function normalizeWfmOrderSubtype(value: unknown): WfmOrderSubtype | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return WFM_ORDER_SUBTYPE_SET.has(normalized) ? (normalized as WfmOrderSubtype) : null;
}

export interface WfmOrderBookEntry {
  userName: string;
  status: string | null;
  platinum: number;
  quantity: number;
  rank: number | null;
  avatar: string | null;
}

type WfmOrderType = "sell" | "buy";

interface WfmOrderPriceEntry {
  platinum: number;
  status: string | null;
}

const MAX_ORDER_BOOK_ENTRIES_PER_SIDE = 500;

function parseOrderType(order: Record<string, unknown>): WfmOrderType | null {
  const typeV1 = typeof order.order_type === "string" ? order.order_type.toLowerCase() : "";
  if (typeV1 === "sell" || typeV1 === "buy") return typeV1;
  const typeV2 = typeof order.type === "string" ? order.type.toLowerCase() : "";
  if (typeV2 === "sell" || typeV2 === "buy") return typeV2;
  return null;
}

function parseOrderUserName(order: Record<string, unknown>): string {
  const user = order.user as Record<string, unknown> | undefined;
  if (!user) return "";
  const nameV1 = typeof user.ingame_name === "string" ? user.ingame_name.trim() : "";
  if (nameV1) return nameV1;
  const nameV2 = typeof user.ingameName === "string" ? user.ingameName.trim() : "";
  return nameV2;
}

function parseOrderStatus(order: Record<string, unknown>): string | null {
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

export function bestOrderPrice(
  entries: WfmOrderPriceEntry[],
  orderType: WfmOrderType,
  activeOnly: boolean,
): number | null {
  const list = activeOnly ? entries.filter((entry) => isActiveOrderStatus(entry.status)) : entries;
  if (list.length === 0) return null;
  const prices = list.map((entry) => entry.platinum);
  return orderType === "sell" ? Math.min(...prices) : Math.max(...prices);
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

      return {
        userName,
        status: parseOrderStatus(order),
        platinum: Math.round(platinumRaw),
        quantity,
        rank,
        avatar: parseOrderAvatar(order),
      } satisfies WfmOrderBookEntry;
    })
    .filter((entry): entry is WfmOrderBookEntry => entry != null);

  entries.sort((a, b) => {
    if (a.platinum !== b.platinum) {
      return orderType === "sell" ? a.platinum - b.platinum : b.platinum - a.platinum;
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
