// Cross-runtime Trade Workbench contract: the renderer builds and previews a
// selling plan, the main process journals every mutation and executes it.

/** Hard per-run cap; a bigger queue executes as several confirmed runs. */
export const WORKBENCH_MAX_ROWS_PER_RUN = 20;
/** Parse bound for hostile payloads, above the run cap on purpose so the
 *  validator (not the parser) is what reports an oversized plan. */
const MAX_PARSED_ROWS = 100;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_SLUG_LENGTH = 120;
const MAX_PLATINUM = 100_000;
const MAX_QUANTITY = 999;
const MAX_REASON_KEYS = 16;
/** Well above a normal account's live sell orders; the rest is dropped. */
const MAX_KNOWN_ORDER_IDS = 400;

export type WorkbenchRowMode = "create" | "update";

/** User consent to sell copies the safety engine reserved. */
interface WorkbenchOverride {
  acknowledgedAt: number;
  /** Safety reservation reason keys that were on screen when the user confirmed. */
  reasonKeys: readonly string[];
}

export interface WorkbenchPlanRow {
  rowId: string;
  mode: WorkbenchRowMode;
  /** WFM catalog slug; main resolves the item id at execution time. */
  slug: string;
  /** English name, kept in the journal so review reads without a catalog. */
  itemName: string;
  quantity: number;
  platinum: number;
  rank?: number;
  subtype?: string;
  /** Existing sell order to reprice/restock; required in "update" mode. */
  orderId?: string;
  override?: WorkbenchOverride;
}

export interface WorkbenchPlan {
  planId: string;
  createdAt: number;
  rows: WorkbenchPlanRow[];
  /** Own sell-order ids that already existed when the plan was built. Review
   *  needs them so a pre-run order can never be read as a create that landed. */
  knownOrderIds?: string[];
}

interface WorkbenchSafetyRowSnapshot {
  safe: number;
  total: number;
}

/** Captured by the renderer from the live safety engine at confirm time; the
 *  execute handler re-validates against it, never against the stale queue. */
export interface WorkbenchSafetySnapshot {
  capturedAt: number;
  rows: Record<string, WorkbenchSafetyRowSnapshot>;
}

type WorkbenchRowRejection =
  | "missing-safety"
  | "over-safe"
  | "over-total"
  | "bad-quantity"
  | "bad-price"
  | "missing-order-id";

interface WorkbenchRowValidation {
  rowId: string;
  ok: boolean;
  reason?: WorkbenchRowRejection;
}

export interface WorkbenchPlanValidation {
  ok: boolean;
  /** Set when the plan is rejected as a whole (cap, duplicates), not per row. */
  planError?: "too-many-rows" | "duplicate-row-ids" | "empty";
  rows: WorkbenchRowValidation[];
  totalUnits: number;
  totalPlatinum: number;
}

type WorkbenchRowStatus = "pending" | "in-flight" | "done" | "failed" | "cancelled" | "blocked";

export interface WorkbenchRowProgress {
  rowId: string;
  itemName: string;
  status: WorkbenchRowStatus;
  orderId?: string;
  error?: string;
}

export type WorkbenchStopReason = "completed" | "cancelled" | "order-limit" | "auth" | "error";

export interface WorkbenchRunProgress {
  planId: string;
  startedAt: number;
  finishedAt?: number;
  stopReason?: WorkbenchStopReason;
  rows: WorkbenchRowProgress[];
}

export interface WorkbenchState {
  phase: "idle" | "running" | "cancelling" | "review";
  /** True until every journaled intent is settled or explicitly resolved. */
  reviewRequired: boolean;
  /** Set when the journal file was unreadable; review is forced until reset. */
  journalError: string | null;
  unsettledCount: number;
  run: WorkbenchRunProgress | null;
}

export type WorkbenchReviewClassification = "confirmed" | "failed" | "unknown";

export interface WorkbenchReviewRow {
  intentId: string;
  planId: string;
  rowId: string;
  mode: WorkbenchRowMode;
  itemName: string;
  slug: string;
  platinum: number;
  quantity: number;
  createdAt: number;
  classification: WorkbenchReviewClassification;
  /** Live order that proves the mutation landed, when one was found. */
  matchedOrderId?: string;
}

export interface WorkbenchReviewReport {
  generatedAt: number;
  rows: WorkbenchReviewRow[];
  fetchError?: string;
}

interface WorkbenchReviewResolution {
  intentId: string;
  classification: WorkbenchReviewClassification;
}

export interface WorkbenchResolveReviewPayload {
  resolutions: WorkbenchReviewResolution[];
  /** Explicit consent to replace an unreadable journal with a fresh one. */
  resetCorruptJournal?: boolean;
}

export interface WorkbenchOverrideAck {
  planId: string;
  rowId: string;
  itemName: string;
  safeQuantity: number;
  requestedQuantity: number;
  reasonKeys: readonly string[];
  acknowledgedAt: number;
}

export interface WorkbenchExecuteResult {
  started: boolean;
  error?: string;
  validation?: WorkbenchPlanValidation;
  state: WorkbenchState;
}

/** WFM caps concurrent orders by account tier and the exact error string is
 *  undocumented, so require an order context AND a cap word. A bare rate-limit
 *  message ("rate limit hit") carries no order context and stays transient. */
export function isOrderLimitErrorMessage(message: string): boolean {
  if (!message) return false;
  if (!/order/i.test(message)) return false;
  return /limit|too\s+many|maximum/i.test(message);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/** A rowId named after an Object.prototype member would resolve through the
 *  prototype chain when the safety snapshot is read by id, so it is refused. */
function isPrototypeMemberName(name: string): boolean {
  return name === "prototype" || name in Object.prototype;
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseReasonKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const entry of value.slice(0, MAX_REASON_KEYS)) {
    const key = boundedString(entry, MAX_NAME_LENGTH);
    if (key) keys.push(key);
  }
  return keys;
}

function parsePlanRow(raw: unknown): WorkbenchPlanRow | null {
  if (!isRecord(raw)) return null;
  const rowId = boundedString(raw.rowId, MAX_ID_LENGTH);
  const slug = boundedString(raw.slug, MAX_SLUG_LENGTH);
  const itemName = boundedString(raw.itemName, MAX_NAME_LENGTH);
  const quantity = boundedInt(raw.quantity, 1, MAX_QUANTITY);
  const platinum = boundedInt(raw.platinum, 1, MAX_PLATINUM);
  const mode = raw.mode === "create" || raw.mode === "update" ? raw.mode : null;
  if (!rowId || !slug || !itemName || quantity == null || platinum == null || !mode) return null;
  if (isPrototypeMemberName(rowId)) return null;

  const row: WorkbenchPlanRow = { rowId, mode, slug, itemName, quantity, platinum };

  const rank = boundedInt(raw.rank, 0, 10);
  if (rank != null) row.rank = rank;
  const subtype = boundedString(raw.subtype, 32);
  if (subtype) row.subtype = subtype;
  const orderId = boundedString(raw.orderId, MAX_ID_LENGTH);
  if (orderId) row.orderId = orderId;
  if (mode === "update" && !orderId) return null;

  if (isRecord(raw.override)) {
    const acknowledgedAt = boundedInt(raw.override.acknowledgedAt, 0, Number.MAX_SAFE_INTEGER);
    if (acknowledgedAt == null) return null;
    row.override = { acknowledgedAt, reasonKeys: parseReasonKeys(raw.override.reasonKeys) };
  }
  return row;
}

/** Hostile-input boundary: null for anything that is not a well-formed plan. */
export function parseWorkbenchPlan(raw: unknown): WorkbenchPlan | null {
  if (!isRecord(raw)) return null;
  const planId = boundedString(raw.planId, MAX_ID_LENGTH);
  const createdAt = boundedInt(raw.createdAt, 0, Number.MAX_SAFE_INTEGER);
  if (!planId || createdAt == null || !Array.isArray(raw.rows)) return null;
  // The journal indexes preexisting order ids by planId, same hazard as rowId.
  if (isPrototypeMemberName(planId)) return null;
  if (raw.rows.length > MAX_PARSED_ROWS) return null;
  const rows: WorkbenchPlanRow[] = [];
  for (const entry of raw.rows) {
    const row = parsePlanRow(entry);
    if (!row) return null;
    rows.push(row);
  }
  const plan: WorkbenchPlan = { planId, createdAt, rows };
  if (Array.isArray(raw.knownOrderIds)) {
    const ids: string[] = [];
    for (const entry of raw.knownOrderIds.slice(0, MAX_KNOWN_ORDER_IDS)) {
      const id = boundedString(entry, MAX_ID_LENGTH);
      if (id) ids.push(id);
    }
    if (ids.length > 0) plan.knownOrderIds = ids;
  }
  return plan;
}

export function parseWorkbenchSafetySnapshot(raw: unknown): WorkbenchSafetySnapshot | null {
  if (!isRecord(raw)) return null;
  const capturedAt = boundedInt(raw.capturedAt, 0, Number.MAX_SAFE_INTEGER);
  if (capturedAt == null || !isRecord(raw.rows)) return null;
  const rows: Record<string, WorkbenchSafetyRowSnapshot> = {};
  let kept = 0;
  for (const [key, entry] of Object.entries(raw.rows)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (!isRecord(entry)) return null;
    const safe = boundedInt(entry.safe, 0, Number.MAX_SAFE_INTEGER);
    const total = boundedInt(entry.total, 0, Number.MAX_SAFE_INTEGER);
    if (safe == null || total == null) return null;
    rows[key] = { safe, total };
    if (++kept > MAX_PARSED_ROWS * 4) return null;
  }
  return { capturedAt, rows };
}

export function parseWorkbenchOverrideAck(raw: unknown): WorkbenchOverrideAck | null {
  if (!isRecord(raw)) return null;
  const planId = boundedString(raw.planId, MAX_ID_LENGTH);
  const rowId = boundedString(raw.rowId, MAX_ID_LENGTH);
  const itemName = boundedString(raw.itemName, MAX_NAME_LENGTH);
  const safeQuantity = boundedInt(raw.safeQuantity, 0, MAX_QUANTITY);
  const requestedQuantity = boundedInt(raw.requestedQuantity, 1, MAX_QUANTITY);
  const acknowledgedAt = boundedInt(raw.acknowledgedAt, 0, Number.MAX_SAFE_INTEGER);
  if (
    !planId ||
    !rowId ||
    !itemName ||
    safeQuantity == null ||
    requestedQuantity == null ||
    acknowledgedAt == null
  ) {
    return null;
  }
  return {
    planId,
    rowId,
    itemName,
    safeQuantity,
    requestedQuantity,
    reasonKeys: parseReasonKeys(raw.reasonKeys),
    acknowledgedAt,
  };
}

export function parseWorkbenchResolveReview(raw: unknown): WorkbenchResolveReviewPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.resolutions)) return null;
  if (raw.resolutions.length > MAX_PARSED_ROWS * 4) return null;
  const resolutions: WorkbenchReviewResolution[] = [];
  for (const entry of raw.resolutions) {
    if (!isRecord(entry)) return null;
    const intentId = boundedString(entry.intentId, MAX_ID_LENGTH);
    const classification =
      entry.classification === "confirmed" ||
      entry.classification === "failed" ||
      entry.classification === "unknown"
        ? entry.classification
        : null;
    if (!intentId || !classification) return null;
    resolutions.push({ intentId, classification });
  }
  const payload: WorkbenchResolveReviewPayload = { resolutions };
  if (raw.resetCorruptJournal === true) payload.resetCorruptJournal = true;
  return payload;
}

/** Shared by preview and execute so both report identical verdicts. Every row
 *  must pass; a partially valid plan never executes partially. */
export function validateWorkbenchPlan(
  plan: WorkbenchPlan,
  safety: WorkbenchSafetySnapshot,
): WorkbenchPlanValidation {
  const rows: WorkbenchRowValidation[] = [];
  let totalUnits = 0;
  let totalPlatinum = 0;

  if (plan.rows.length === 0) {
    return { ok: false, planError: "empty", rows, totalUnits, totalPlatinum };
  }
  if (plan.rows.length > WORKBENCH_MAX_ROWS_PER_RUN) {
    return { ok: false, planError: "too-many-rows", rows, totalUnits, totalPlatinum };
  }
  const ids = new Set(plan.rows.map((row) => row.rowId));
  if (ids.size !== plan.rows.length) {
    return { ok: false, planError: "duplicate-row-ids", rows, totalUnits, totalPlatinum };
  }

  let ok = true;
  for (const row of plan.rows) {
    const verdict: WorkbenchRowValidation = { rowId: row.rowId, ok: true };
    // Own property only: an inherited member would leave both quantity
    // comparisons below reading undefined, and the row would pass uncapped.
    const snapshot = Object.prototype.hasOwnProperty.call(safety.rows, row.rowId)
      ? safety.rows[row.rowId]
      : undefined;
    if (!Number.isInteger(row.quantity) || row.quantity < 1) {
      verdict.ok = false;
      verdict.reason = "bad-quantity";
    } else if (!Number.isInteger(row.platinum) || row.platinum < 1) {
      verdict.ok = false;
      verdict.reason = "bad-price";
    } else if (row.mode === "update" && !row.orderId) {
      verdict.ok = false;
      verdict.reason = "missing-order-id";
    } else if (!snapshot) {
      verdict.ok = false;
      verdict.reason = "missing-safety";
    } else if (row.quantity > snapshot.total) {
      // An override never authorizes selling more than the account holds.
      verdict.ok = false;
      verdict.reason = "over-total";
    } else if (row.quantity > snapshot.safe && !row.override) {
      verdict.ok = false;
      verdict.reason = "over-safe";
    }
    if (!verdict.ok) ok = false;
    else {
      totalUnits += row.quantity;
      totalPlatinum += row.quantity * row.platinum;
    }
    rows.push(verdict);
  }

  return { ok, rows, totalUnits, totalPlatinum };
}
