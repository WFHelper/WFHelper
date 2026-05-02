export interface WfmOrderBookEntry {
  userName: string;
  status: string | null;
  platinum: number;
  quantity: number;
  rank: number | null;
}

export type WfmOrderType = "sell" | "buy";

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

  return entries.slice(0, MAX_ORDER_BOOK_ENTRIES_PER_SIDE);
}
