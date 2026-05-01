const SNAPSHOT_VERSION = 1;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ValidSnapshotBlob {
  version: number;
  generatedAt: number;
  prices: Record<string, unknown>;
  meta: Record<string, unknown>;
  orderSummaries: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegative(value: unknown): boolean {
  return value == null || isFiniteNonNegative(value);
}

function isReasonableTimestamp(value: unknown, now = Date.now()): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= now + MAX_FUTURE_SKEW_MS &&
    now - value <= MAX_SNAPSHOT_AGE_MS
  );
}

function isValidCacheKey(key: string): boolean {
  return key.length > 0 && key.length <= 160;
}

function isValidCachedPriceEntry(value: unknown, now = Date.now()): boolean {
  if (!isRecord(value)) return false;
  const status = value.status;
  if (status !== "ok" && status !== "no_data") return false;
  if (!isReasonableTimestamp(value.timestamp, now)) return false;
  if (status === "ok") return isFiniteNonNegative(value.median);
  return value.median == null;
}

function isValidSnapshotMetaEntry(value: unknown, now = Date.now()): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.slug !== "string" || !value.slug) return false;
  if (!isReasonableTimestamp(value.timestamp, now)) return false;
  if (!isNullableFiniteNonNegative(value.ducats)) return false;
  if (typeof value.setRoot !== "boolean") return false;
  if (value.thumb != null && typeof value.thumb !== "string") return false;
  if (value.icon != null && typeof value.icon !== "string") return false;
  return true;
}

function isValidCachedOrderSummaryEntry(value: unknown, now = Date.now()): boolean {
  if (!isRecord(value)) return false;
  const status = value.status;
  if (status !== "ok" && status !== "no_data") return false;
  if (!isReasonableTimestamp(value.timestamp, now)) return false;
  if (!isNullableFiniteNonNegative(value.wts) || !isNullableFiniteNonNegative(value.wtb)) return false;
  if (value.sourceTimestamp != null && !isReasonableTimestamp(value.sourceTimestamp, now)) return false;
  return true;
}

function allEntriesPass(
  data: Record<string, unknown>,
  validator: (value: unknown, now: number) => boolean,
  now: number,
): boolean {
  for (const [key, value] of Object.entries(data)) {
    if (!isValidCacheKey(key) || !validator(value, now)) return false;
  }
  return true;
}

export function isValidSnapshotBlob(value: unknown, now = Date.now()): value is ValidSnapshotBlob {
  if (!isRecord(value)) return false;
  if (value.version !== SNAPSHOT_VERSION) return false;
  if (!isReasonableTimestamp(value.generatedAt, now)) return false;
  if (!isRecord(value.prices) || !isRecord(value.meta) || !isRecord(value.orderSummaries)) {
    return false;
  }
  return (
    allEntriesPass(value.prices, isValidCachedPriceEntry, now) &&
    allEntriesPass(value.meta, isValidSnapshotMetaEntry, now) &&
    allEntriesPass(value.orderSummaries, isValidCachedOrderSummaryEntry, now)
  );
}
