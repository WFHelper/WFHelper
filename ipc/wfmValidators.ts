import { createRuntimeRequire } from "./runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 1);
const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const WFM_ID_RE = /^[a-f0-9]{24}$/i;
const VALID_ORDER_TYPES = new Set(["sell", "buy"]);
const VALID_STATUSES = new Set(["online", "ingame", "invisible"]);

const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 512;
const SEARCH_QUERY_MAX_LENGTH = 120;
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 100;
const CONTRACTS_PAGE_DEFAULT = 1;
const CONTRACTS_PAGE_MIN = 1;
const CONTRACTS_PAGE_MAX = 500;
const CONTRACTS_LIMIT_DEFAULT = 40;
const CONTRACTS_LIMIT_MIN = 1;
const CONTRACTS_LIMIT_MAX = 100;
const MAX_BULK_ORDER_IDS = 200;
const MAX_PLATINUM = 10_000_000;
const MAX_QUANTITY = 99_999;
const MIN_MOD_RANK = 0;
const MAX_MOD_RANK = 20;

export type ParsedCredentials = { email: string; password: string };
export type ParsedCreateOrderParams = {
  itemId: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank?: number;
};
export type ParsedUpdateOrderPayload = {
  orderId: string;
  updates: {
    platinum?: number;
    quantity?: number;
    visible?: boolean;
    modRank?: number;
  };
};
export type ParsedDeleteOrderPayload = { orderId: string };
export type ParsedCloseOrderPayload = { orderId: string; quantity: number };
export type ParsedSetVisiblePayload = { orderIds: string[]; visible: boolean };
export type ParsedSearchPayload = { query: string; limit: number };
export type ParsedStatusPayload = { status: string };
export type ParsedContractsPayload = { page: number; limit: number };

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toTrimmedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > maxLength) return "";
  return trimmed;
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toClampedInteger(value: unknown, min: number, max: number): number | null {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as { code?: string }).code;
}

function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as { status?: number }).status;
}

function parseCredentials(payload: unknown): ParsedCredentials | null {
  if (!isObject(payload)) return null;

  const email = toTrimmedString(payload.email, EMAIL_MAX_LENGTH);
  const password = toTrimmedString(payload.password, PASSWORD_MAX_LENGTH);
  if (!email || !password) return null;

  return { email, password };
}

function parseCreateOrderParams(payload: unknown): ParsedCreateOrderParams | null {
  if (!isObject(payload)) return null;

  const itemId = toTrimmedString(payload.itemId, 64);
  const orderType = toTrimmedString(payload.orderType, 10).toLowerCase();
  const platinum = toClampedInteger(payload.platinum, 1, MAX_PLATINUM);
  const quantity = toClampedInteger(payload.quantity, 1, MAX_QUANTITY);

  if (!itemId || !WFM_ID_RE.test(itemId)) return null;
  if (!VALID_ORDER_TYPES.has(orderType)) return null;
  if (platinum == null || quantity == null) return null;

  const parsed: ParsedCreateOrderParams = {
    itemId,
    orderType,
    platinum,
    quantity,
    visible: payload.visible === undefined ? true : Boolean(payload.visible),
  };

  if (payload.modRank !== undefined) {
    const modRank = toClampedInteger(payload.modRank, MIN_MOD_RANK, MAX_MOD_RANK);
    if (modRank == null) return null;
    parsed.modRank = modRank;
  }

  return parsed;
}

function parseUpdateOrderPayload(payload: unknown): ParsedUpdateOrderPayload | null {
  if (!isObject(payload)) return null;

  const orderId = toTrimmedString(payload.orderId, 64);
  if (!orderId || !WFM_ID_RE.test(orderId)) return null;

  const updates = isObject(payload.updates) ? payload.updates : {};
  const parsedUpdates: ParsedUpdateOrderPayload["updates"] = {};

  if (updates.platinum !== undefined) {
    const platinum = toClampedInteger(updates.platinum, 1, MAX_PLATINUM);
    if (platinum == null) return null;
    parsedUpdates.platinum = platinum;
  }

  if (updates.quantity !== undefined) {
    const quantity = toClampedInteger(updates.quantity, 1, MAX_QUANTITY);
    if (quantity == null) return null;
    parsedUpdates.quantity = quantity;
  }

  if (updates.visible !== undefined) {
    parsedUpdates.visible = Boolean(updates.visible);
  }

  if (updates.modRank !== undefined) {
    const modRank = toClampedInteger(updates.modRank, MIN_MOD_RANK, MAX_MOD_RANK);
    if (modRank == null) return null;
    parsedUpdates.modRank = modRank;
  }

  return { orderId, updates: parsedUpdates };
}

function parseDeleteOrderPayload(payload: unknown): ParsedDeleteOrderPayload | null {
  if (!isObject(payload)) return null;
  const orderId = toTrimmedString(payload.orderId, 64);
  if (!orderId || !WFM_ID_RE.test(orderId)) return null;
  return { orderId };
}

function parseCloseOrderPayload(payload: unknown): ParsedCloseOrderPayload | null {
  if (!isObject(payload)) return null;
  const orderId = toTrimmedString(payload.orderId, 64);
  if (!orderId || !WFM_ID_RE.test(orderId)) return null;
  const quantity = toClampedInteger(payload.quantity, 1, MAX_QUANTITY);
  if (quantity == null) return null;
  return { orderId, quantity };
}

function parseSetVisiblePayload(payload: unknown): ParsedSetVisiblePayload | null {
  if (!isObject(payload)) return null;
  if (typeof payload.visible !== "boolean") return null;
  if (!Array.isArray(payload.orderIds)) return null;

  const orderIds = payload.orderIds
    .map((value: unknown) => toTrimmedString(value, 64))
    .filter((value: string) => value && WFM_ID_RE.test(value))
    .slice(0, MAX_BULK_ORDER_IDS);

  if (orderIds.length === 0) return null;
  return {
    orderIds,
    visible: payload.visible,
  };
}

function parseSearchPayload(payload: unknown): ParsedSearchPayload | null {
  if (!isObject(payload)) return null;

  const query = toTrimmedString(payload.query, SEARCH_QUERY_MAX_LENGTH);
  if (!query) return null;

  const rawLimit =
    payload.limit === undefined
      ? SEARCH_LIMIT_DEFAULT
      : toClampedInteger(payload.limit, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX);

  if (rawLimit == null) return null;

  return {
    query,
    limit: rawLimit,
  };
}

function parseStatusPayload(payload: unknown): ParsedStatusPayload | null {
  if (!isObject(payload)) return null;

  const status = toTrimmedString(payload.status, 24).toLowerCase();
  if (!VALID_STATUSES.has(status)) return null;

  return { status };
}

function parseContractsPayload(payload: unknown): ParsedContractsPayload | null {
  if (payload == null) {
    return {
      page: CONTRACTS_PAGE_DEFAULT,
      limit: CONTRACTS_LIMIT_DEFAULT,
    };
  }

  if (!isObject(payload)) return null;

  const page =
    payload.page === undefined
      ? CONTRACTS_PAGE_DEFAULT
      : toClampedInteger(payload.page, CONTRACTS_PAGE_MIN, CONTRACTS_PAGE_MAX);

  const limit =
    payload.limit === undefined
      ? CONTRACTS_LIMIT_DEFAULT
      : toClampedInteger(payload.limit, CONTRACTS_LIMIT_MIN, CONTRACTS_LIMIT_MAX);

  if (page == null || limit == null) return null;

  return { page, limit };
}

export {
  parseCredentials,
  parseCreateOrderParams,
  parseUpdateOrderPayload,
  parseDeleteOrderPayload,
  parseCloseOrderPayload,
  parseSetVisiblePayload,
  parseSearchPayload,
  parseStatusPayload,
  parseContractsPayload,
  normalizeErrorMessage,
  errorCode,
  errorStatus,
};
