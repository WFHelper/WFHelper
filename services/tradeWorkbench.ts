import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { writeFileAtomicSync } from "./atomicFile";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { normalizeErrorMessage } from "../config/shared/errors";
import { subtypeChoicesOf } from "../config/shared/wfmOrders";
import {
  isOrderLimitErrorMessage,
  parseWorkbenchOverrideAck,
  validateWorkbenchPlan,
  type WorkbenchExecuteResult,
  type WorkbenchOverrideAck,
  type WorkbenchPlan,
  type WorkbenchPlanRow,
  type WorkbenchResolveReviewPayload,
  type WorkbenchReviewClassification,
  type WorkbenchReviewReport,
  type WorkbenchReviewRow,
  type WorkbenchRowMode,
  type WorkbenchRowProgress,
  type WorkbenchRunProgress,
  type WorkbenchSafetySnapshot,
  type WorkbenchState,
  type WorkbenchStopReason,
} from "../config/shared/tradeWorkbenchTypes";

const log = withScope("tradeWorkbench");

const JOURNAL_FILENAME = "trade-workbench-journal.json";
const MAX_SETTLED_ENTRIES = 300;
const MAX_OVERRIDE_RECORDS = 200;
/** On top of the scheduler budget: user-visible bulk runs stay deliberately slow. */
const DEFAULT_INTER_ROW_DELAY_MS = 400;

interface WorkbenchJournalRequest {
  slug: string;
  itemName: string;
  platinum: number;
  quantity: number;
  rank?: number;
  subtype?: string;
  orderId?: string;
  /** Catalog id resolved just before the send; recorded for the audit trail. */
  itemId?: string;
}

interface WorkbenchJournalEntry {
  intentId: string;
  planId: string;
  rowId: string;
  mode: WorkbenchRowMode;
  request: WorkbenchJournalRequest;
  createdAt: number;
  /** Written only after WFM answered; its absence is what forces review. */
  outcome?: { status: "confirmed" | "failed"; orderId?: string; error?: string; at: number };
  /** The user's explicit review verdict for an intent with no outcome. */
  resolved?: { classification: WorkbenchReviewClassification; at: number };
}

interface WorkbenchJournalFile {
  version: 1;
  entries: WorkbenchJournalEntry[];
  overrides: WorkbenchOverrideAck[];
  /** planId -> own sell-order ids that already existed when the run started. */
  preexistingOrderIds?: Record<string, string[]>;
}

/** The own-order fields review classifies against. */
type OwnSellOrder = {
  id: string;
  platinum: number;
  quantity: number;
  modRank: number | null;
  itemUrlName: string | null;
  subtype?: string | null;
};

/** The order surface the engine drives; production wires services/wfmOrders +
 *  services/wfmCatalog, tests inject fakes so nothing touches the network. */
export interface WorkbenchOrderApi {
  createOrder(params: {
    itemId: string;
    orderType: "sell";
    platinum: number;
    quantity: number;
    visible: boolean;
    modRank?: number | null;
    subtype?: string | null;
  }): Promise<{ id: string }>;
  updateOrder(
    orderId: string,
    updates: { platinum?: number; quantity?: number; visible?: boolean },
  ): Promise<{ id: string }>;
  getMyOrders(): Promise<{ sell: OwnSellOrder[] }>;
  lookupItemIdBySlug(slug: string): Promise<string | null>;
}

function productionApi(): WorkbenchOrderApi {
  // Late require keeps the WFM client chain out of processes that only read state.
  const wfmOrders = require("./wfmOrders") as typeof import("./wfmOrders");
  const wfmCatalog = require("./wfmCatalog") as typeof import("./wfmCatalog");
  return {
    createOrder: (params) => wfmOrders.createOrder(params),
    updateOrder: (orderId, updates) => wfmOrders.updateOrder(orderId, updates),
    getMyOrders: () => wfmOrders.getMyOrders(),
    lookupItemIdBySlug: async (slug) => {
      const item = await wfmCatalog.lookupBySlug(slug);
      return item?.id || null;
    },
  };
}

let _api: WorkbenchOrderApi | null = null;
let _onState: ((state: WorkbenchState) => void) | null = null;
let _interRowDelayMs = DEFAULT_INTER_ROW_DELAY_MS;

let _initialized = false;
/** Null while the on-disk journal is unreadable; only an explicit reset writes then. */
let _journal: WorkbenchJournalFile | null = null;
let _journalError: string | null = null;

let _run: WorkbenchRunProgress | null = null;
let _running = false;
let _cancelRequested = false;

export function configureTradeWorkbench(options: {
  api?: WorkbenchOrderApi;
  onState?: (state: WorkbenchState) => void;
  interRowDelayMs?: number;
}): void {
  if (options.api) _api = options.api;
  if (options.onState) _onState = options.onState;
  if (options.interRowDelayMs != null) _interRowDelayMs = options.interRowDelayMs;
}

function api(): WorkbenchOrderApi {
  if (!_api) _api = productionApi();
  return _api;
}

function journalPath(): string {
  return userDataPath(JOURNAL_FILENAME);
}

function isJournalEntry(value: unknown): value is WorkbenchJournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const request = entry.request as Record<string, unknown> | undefined;
  return (
    typeof entry.intentId === "string" &&
    typeof entry.planId === "string" &&
    typeof entry.rowId === "string" &&
    (entry.mode === "create" || entry.mode === "update") &&
    typeof entry.createdAt === "number" &&
    !!request &&
    typeof request === "object" &&
    typeof request.slug === "string" &&
    typeof request.itemName === "string" &&
    typeof request.platinum === "number" &&
    typeof request.quantity === "number"
  );
}

function loadJournal(): void {
  _journal = null;
  _journalError = null;
  let text: string;
  try {
    text = fs.readFileSync(journalPath(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      _journal = { version: 1, entries: [], overrides: [] };
      return;
    }
    _journalError = `journal unreadable: ${normalizeErrorMessage(err)}`;
    log.error(`[Workbench] ${_journalError}`);
    return;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = parsed as Record<string, unknown>;
    if (!record || typeof record !== "object" || record.version !== 1) {
      throw new Error("unexpected journal shape");
    }
    const entriesRaw = Array.isArray(record.entries) ? record.entries : null;
    if (!entriesRaw) throw new Error("journal entries missing");
    const entries: WorkbenchJournalEntry[] = [];
    for (const entry of entriesRaw) {
      if (!isJournalEntry(entry)) throw new Error("malformed journal entry");
      entries.push(entry);
    }
    // Acks are an audit trail, so a hand-edited file must not be able to seed
    // arbitrary values; junk entries drop instead of failing the whole journal.
    const overrides = Array.isArray(record.overrides)
      ? record.overrides
          .map((entry) => parseWorkbenchOverrideAck(entry))
          .filter((ack): ack is WorkbenchOverrideAck => ack != null)
      : [];
    _journal = { version: 1, entries, overrides };
    const known = record.preexistingOrderIds;
    if (known && typeof known === "object" && !Array.isArray(known)) {
      const parsed: Record<string, string[]> = {};
      for (const [planId, ids] of Object.entries(known as Record<string, unknown>)) {
        if (planId === "__proto__" || !Array.isArray(ids)) continue;
        parsed[planId] = ids.filter((id): id is string => typeof id === "string");
      }
      _journal.preexistingOrderIds = parsed;
    }
  } catch (err) {
    // A journal that cannot be trusted forces review; it is never overwritten
    // here so the user (or a bug report) can still inspect the raw file.
    _journalError = `journal corrupt: ${normalizeErrorMessage(err)}`;
    log.error(`[Workbench] ${_journalError}`);
  }
}

function isSettled(entry: WorkbenchJournalEntry): boolean {
  return entry.outcome != null || entry.resolved != null;
}

function pruneJournal(journal: WorkbenchJournalFile): void {
  const unsettled = journal.entries.filter((entry) => !isSettled(entry));
  const settled = journal.entries.filter(isSettled);
  if (settled.length > MAX_SETTLED_ENTRIES) {
    settled.splice(0, settled.length - MAX_SETTLED_ENTRIES);
  }
  journal.entries = [...settled, ...unsettled].sort((a, b) => a.createdAt - b.createdAt);
  if (journal.overrides.length > MAX_OVERRIDE_RECORDS) {
    journal.overrides.splice(0, journal.overrides.length - MAX_OVERRIDE_RECORDS);
  }
  if (journal.preexistingOrderIds) {
    // The snapshot only matters while its plan still has entries to classify.
    const livePlans = new Set(journal.entries.map((entry) => entry.planId));
    for (const planId of Object.keys(journal.preexistingOrderIds)) {
      if (!livePlans.has(planId)) delete journal.preexistingOrderIds[planId];
    }
  }
}

function saveJournal(): void {
  if (!_journal) throw new Error("workbench journal not writable");
  pruneJournal(_journal);
  writeFileAtomicSync(journalPath(), JSON.stringify(_journal, null, 2));
}

export function initTradeWorkbench(): void {
  if (_initialized) return;
  _initialized = true;
  loadJournal();
  const state = getWorkbenchState();
  if (state.reviewRequired) {
    log.warn(
      `[Workbench] starting in review mode (${state.unsettledCount} unsettled intent(s)` +
        `${_journalError ? `, ${_journalError}` : ""})`,
    );
  }
}

function unsettledEntries(): WorkbenchJournalEntry[] {
  return _journal ? _journal.entries.filter((entry) => !isSettled(entry)) : [];
}

export function getWorkbenchState(): WorkbenchState {
  if (!_initialized) initTradeWorkbench();
  const unsettled = unsettledEntries().length;
  const reviewRequired = _journalError != null || unsettled > 0;
  let phase: WorkbenchState["phase"] = "idle";
  if (_running) phase = _cancelRequested ? "cancelling" : "running";
  else if (reviewRequired) phase = "review";
  return {
    phase,
    reviewRequired,
    journalError: _journalError,
    unsettledCount: unsettled,
    run: _run,
  };
}

function emitState(): void {
  if (_onState) _onState(getWorkbenchState());
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowProgress(run: WorkbenchRunProgress, rowId: string): WorkbenchRowProgress {
  const row = run.rows.find((entry) => entry.rowId === rowId);
  if (!row) throw new Error(`unknown workbench row ${rowId}`);
  return row;
}

function markRemaining(
  run: WorkbenchRunProgress,
  fromIndex: number,
  status: "cancelled" | "blocked",
): void {
  for (let i = fromIndex; i < run.rows.length; i++) {
    if (run.rows[i].status === "pending") run.rows[i].status = status;
  }
}

function requestForRow(row: WorkbenchPlanRow): WorkbenchJournalRequest {
  const request: WorkbenchJournalRequest = {
    slug: row.slug,
    itemName: row.itemName,
    platinum: row.platinum,
    quantity: row.quantity,
  };
  if (row.rank != null) request.rank = row.rank;
  if (row.subtype) request.subtype = row.subtype;
  if (row.orderId) request.orderId = row.orderId;
  return request;
}

function journalIntent(plan: WorkbenchPlan, row: WorkbenchPlanRow, itemId: string | null): string {
  if (!_journal) throw new Error("workbench journal not writable");
  const intentId = randomUUID();
  const request = requestForRow(row);
  if (itemId) request.itemId = itemId;
  _journal.entries.push({
    intentId,
    planId: plan.planId,
    rowId: row.rowId,
    mode: row.mode,
    request,
    createdAt: Date.now(),
  });
  saveJournal();
  return intentId;
}

function journalOutcome(
  intentId: string,
  status: "confirmed" | "failed",
  detail: { orderId?: string; error?: string },
): void {
  if (!_journal) return;
  const entry = _journal.entries.find((candidate) => candidate.intentId === intentId);
  if (!entry) return;
  const outcome: WorkbenchJournalEntry["outcome"] = { status, at: Date.now() };
  if (detail.orderId) outcome.orderId = detail.orderId;
  if (detail.error) outcome.error = detail.error;
  entry.outcome = outcome;
  try {
    saveJournal();
  } catch (err) {
    // The mutation already happened; a failed outcome write must not lose it
    // silently, so the entry stays unsettled and the next start forces review.
    log.error("[Workbench] failed to persist outcome:", normalizeErrorMessage(err));
  }
}

function errorCodeOf(err: unknown): string | null {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return null;
}

async function runPlan(plan: WorkbenchPlan): Promise<void> {
  const run = _run;
  if (!run) return;
  let stopReason: WorkbenchStopReason = "completed";

  for (let index = 0; index < plan.rows.length; index++) {
    if (_cancelRequested) {
      markRemaining(run, index, "cancelled");
      stopReason = "cancelled";
      break;
    }
    const row = plan.rows[index];
    const progress = rowProgress(run, row.rowId);
    progress.status = "in-flight";
    emitState();

    let itemId: string | null = null;
    if (row.mode === "create") {
      try {
        itemId = await api().lookupItemIdBySlug(row.slug);
      } catch (err) {
        itemId = null;
        log.warn(`[Workbench] catalog lookup failed for ${row.slug}:`, normalizeErrorMessage(err));
      }
      if (!itemId) {
        progress.status = "failed";
        progress.error = `No warframe.market item for "${row.slug}"`;
        emitState();
        continue;
      }
    }

    // Write-ahead: the intent must be durable before the request leaves, or a
    // crash in flight would leave an untracked live mutation.
    let intentId: string;
    try {
      intentId = journalIntent(plan, row, itemId);
    } catch (err) {
      progress.status = "failed";
      progress.error = `journal write failed: ${normalizeErrorMessage(err)}`;
      markRemaining(run, index + 1, "blocked");
      stopReason = "error";
      emitState();
      break;
    }

    try {
      if (row.mode === "update" && row.orderId) {
        const updated = await api().updateOrder(row.orderId, {
          platinum: row.platinum,
          quantity: row.quantity,
        });
        journalOutcome(intentId, "confirmed", { orderId: updated.id });
        progress.status = "done";
        progress.orderId = updated.id;
      } else {
        const created = await api().createOrder({
          itemId: itemId as string,
          orderType: "sell",
          platinum: row.platinum,
          quantity: row.quantity,
          visible: true,
          ...(row.rank != null ? { modRank: row.rank } : {}),
          ...(row.subtype ? { subtype: row.subtype } : {}),
        });
        journalOutcome(intentId, "confirmed", { orderId: created.id });
        progress.status = "done";
        progress.orderId = created.id;
      }
    } catch (err) {
      // A subtype the user never chose is not something a bulk run may guess,
      // so the row is reported with the choices and left for the order dialog.
      const choices = subtypeChoicesOf(err);
      const message = choices
        ? `Pick a subtype for "${row.itemName}" on warframe.market: ${choices.join(", ")}`
        : normalizeErrorMessage(err);
      journalOutcome(intentId, "failed", { error: message });
      progress.status = "failed";
      progress.error = message;
      if (isOrderLimitErrorMessage(message)) {
        // Account-tier order cap: every further create would hit the same wall.
        markRemaining(run, index + 1, "blocked");
        stopReason = "order-limit";
        emitState();
        break;
      }
      if (errorCodeOf(err) === "WFM_UNAUTHORIZED") {
        markRemaining(run, index + 1, "blocked");
        stopReason = "auth";
        emitState();
        break;
      }
    }
    emitState();
    if (index < plan.rows.length - 1) await sleep(_interRowDelayMs);
  }

  run.finishedAt = Date.now();
  run.stopReason = stopReason;
  _running = false;
  _cancelRequested = false;
  emitState();
  log.info(
    `[Workbench] run ${run.planId} finished: ${stopReason} ` +
      `(${run.rows.filter((r) => r.status === "done").length}/${run.rows.length} done)`,
  );
}

export function executeWorkbenchPlan(
  plan: WorkbenchPlan,
  safety: WorkbenchSafetySnapshot,
): WorkbenchExecuteResult {
  if (!_initialized) initTradeWorkbench();
  const state = getWorkbenchState();
  if (_running) {
    return { started: false, error: "A workbench run is already active.", state };
  }
  if (state.reviewRequired) {
    return {
      started: false,
      error: "Unreconciled journal entries require review before executing.",
      state,
    };
  }
  const validation = validateWorkbenchPlan(plan, safety);
  if (!validation.ok) {
    return { started: false, error: "Plan failed safety validation.", validation, state };
  }

  if (_journal && plan.knownOrderIds && plan.knownOrderIds.length > 0) {
    _journal.preexistingOrderIds = {
      ...(_journal.preexistingOrderIds ?? {}),
      [plan.planId]: [...plan.knownOrderIds],
    };
  }

  _run = {
    planId: plan.planId,
    startedAt: Date.now(),
    rows: plan.rows.map((row) => ({ rowId: row.rowId, itemName: row.itemName, status: "pending" })),
  };
  _running = true;
  _cancelRequested = false;
  emitState();
  void runPlan(plan).catch((err) => {
    // Defensive: runPlan settles per row; anything escaping is a logic error.
    log.error("[Workbench] run crashed:", normalizeErrorMessage(err));
    _running = false;
    _cancelRequested = false;
    if (_run && !_run.finishedAt) {
      _run.finishedAt = Date.now();
      _run.stopReason = "error";
    }
    emitState();
  });
  return { started: true, validation, state: getWorkbenchState() };
}

/** Cancels after the in-flight operation settles; nothing is aborted mid-request. */
export function cancelWorkbenchRun(): WorkbenchState {
  if (_running) {
    _cancelRequested = true;
    emitState();
  }
  return getWorkbenchState();
}

export function acknowledgeWorkbenchOverride(ack: WorkbenchOverrideAck): WorkbenchState {
  if (!_initialized) initTradeWorkbench();
  if (_journal) {
    _journal.overrides.push(ack);
    try {
      saveJournal();
    } catch (err) {
      log.warn("[Workbench] failed to persist override ack:", normalizeErrorMessage(err));
    }
  }
  return getWorkbenchState();
}

/** WFM leaves the default subtype unset; both spellings mean the same thing. */
function normalizeSubtype(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return !trimmed || trimmed === "regular" ? null : trimmed;
}

function preexistingOrderIds(planId: string): ReadonlySet<string> {
  const known = _journal?.preexistingOrderIds;
  // Own property only: a planId like "toString" would resolve to a function.
  if (!known || !Object.prototype.hasOwnProperty.call(known, planId)) return new Set();
  return new Set(known[planId] ?? []);
}

function classifyEntry(
  entry: WorkbenchJournalEntry,
  sellOrders: OwnSellOrder[],
): { classification: WorkbenchReviewClassification; matchedOrderId?: string } {
  if (entry.mode === "update") {
    const order = sellOrders.find((candidate) => candidate.id === entry.request.orderId);
    if (!order) return { classification: "unknown" };
    if (order.platinum !== entry.request.platinum) return { classification: "failed" };
    // A short quantity can mean the update never applied or that units sold
    // after it did, so the price alone never proves the whole update landed.
    if (order.quantity !== entry.request.quantity) return { classification: "unknown" };
    return { classification: "confirmed", matchedOrderId: order.id };
  }
  const known = preexistingOrderIds(entry.planId);
  const match = sellOrders.find(
    (candidate) =>
      // An order that was already there before the run proves nothing about a
      // create; matching one would confirm an intent that never left.
      !known.has(candidate.id) &&
      candidate.itemUrlName === entry.request.slug &&
      candidate.platinum === entry.request.platinum &&
      candidate.quantity === entry.request.quantity &&
      (entry.request.rank == null || candidate.modRank === entry.request.rank) &&
      normalizeSubtype(candidate.subtype) === normalizeSubtype(entry.request.subtype),
  );
  if (match) return { classification: "confirmed", matchedOrderId: match.id };
  // Absence proves nothing: the create may have failed, or landed and sold out.
  return { classification: "unknown" };
}

/** Re-fetches our own orders and classifies unsettled intents. Read-only: the
 *  journal is only settled by resolveWorkbenchReview, after the user confirms. */
export async function reconcileWorkbench(): Promise<WorkbenchReviewReport> {
  if (!_initialized) initTradeWorkbench();
  const rows: WorkbenchReviewRow[] = [];
  const unsettled = unsettledEntries();

  let sellOrders: OwnSellOrder[] = [];
  let fetchError: string | undefined;
  if (unsettled.length > 0) {
    try {
      sellOrders = (await api().getMyOrders()).sell;
    } catch (err) {
      fetchError = normalizeErrorMessage(err);
    }
  }

  for (const entry of unsettled) {
    const { classification, matchedOrderId } = fetchError
      ? { classification: "unknown" as const }
      : classifyEntry(entry, sellOrders);
    const row: WorkbenchReviewRow = {
      intentId: entry.intentId,
      planId: entry.planId,
      rowId: entry.rowId,
      mode: entry.mode,
      itemName: entry.request.itemName,
      slug: entry.request.slug,
      platinum: entry.request.platinum,
      quantity: entry.request.quantity,
      createdAt: entry.createdAt,
      classification,
    };
    if (matchedOrderId) row.matchedOrderId = matchedOrderId;
    rows.push(row);
  }

  const report: WorkbenchReviewReport = { generatedAt: Date.now(), rows };
  if (fetchError) report.fetchError = fetchError;
  return report;
}

export function resolveWorkbenchReview(payload: WorkbenchResolveReviewPayload): WorkbenchState {
  if (!_initialized) initTradeWorkbench();
  if (_journalError && payload.resetCorruptJournal) {
    // Explicit user consent: replace the unreadable file with a fresh journal.
    _journal = { version: 1, entries: [], overrides: [] };
    _journalError = null;
    try {
      saveJournal();
      log.warn("[Workbench] corrupt journal replaced after explicit review confirmation");
    } catch (err) {
      _journalError = `journal reset failed: ${normalizeErrorMessage(err)}`;
      log.error(`[Workbench] ${_journalError}`);
    }
    emitState();
    return getWorkbenchState();
  }
  if (!_journal) return getWorkbenchState();

  let changed = false;
  for (const resolution of payload.resolutions) {
    // "unknown" is the absence of a verdict, so it leaves the intent open; only
    // an explicit confirmed/failed from the user settles a row.
    if (resolution.classification === "unknown") continue;
    const entry = _journal.entries.find(
      (candidate) => candidate.intentId === resolution.intentId && !isSettled(candidate),
    );
    if (!entry) continue;
    entry.resolved = { classification: resolution.classification, at: Date.now() };
    changed = true;
  }
  if (changed) {
    try {
      saveJournal();
    } catch (err) {
      log.error("[Workbench] failed to persist review resolution:", normalizeErrorMessage(err));
    }
  }
  emitState();
  return getWorkbenchState();
}
