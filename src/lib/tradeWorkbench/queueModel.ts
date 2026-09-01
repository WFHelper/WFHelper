import {
  safeToList,
  safetyKeyFor,
  type SafetyContext,
  type SafetyReservation,
  type SafetyVerdict,
} from "../inventory/safetyRules.js";
import { getLookupByName } from "../inventoryMarket.js";
import { normalizeMarketName } from "../marketNaming.js";
import {
  suggestPrice,
  type DampingRule,
  type PriceSuggestion,
  type PricingListing,
  type StrategyConfig,
} from "./pricingStrategies.js";
import { isRankedGroup } from "../../../config/shared/numeric.js";
import {
  WORKBENCH_MAX_ROWS_PER_RUN,
  type WorkbenchPlan,
  type WorkbenchPlanRow,
  type WorkbenchSafetySnapshot,
} from "../../../config/shared/tradeWorkbenchTypes.js";
import { isWfmExcludedSlug } from "../../../config/shared/wfmExclusions.js";
import { isActiveOrderStatus } from "../../../config/shared/wfmOrders.js";
import type { ParsedItem } from "../../types/inventory.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import type { WfmOrder } from "../../types/market.js";

type WorkbenchQueueWarning =
  | "no-listing-data"
  | "low-liquidity"
  | "no-price"
  | "override-needed"
  | "fully-protected";

interface WorkbenchMarketInfo {
  lowestSell: number | null;
  highestBuy: number | null;
  /** Sellers currently ingame/online; the liquidity signal shown per row. */
  activeSellers: number;
  spread: number | null;
}

export interface WorkbenchQueueRow {
  rowId: string;
  item: ParsedItem;
  itemName: string;
  slug: string;
  rank: number | null;
  verdict: SafetyVerdict;
  /** Units to list; starts at the safe count and never exceeds the total. */
  quantity: number;
  /** Set by an explicit per-row confirmation; required beyond the safe count. */
  overrideAcknowledged: boolean;
  overrideAcknowledgedAt: number | null;
  selected: boolean;
  existingOrder: { id: string; platinum: number; quantity: number } | null;
  market: WorkbenchMarketInfo | null;
  /** Raw sell book kept on the row so strategies can be re-applied locally. */
  sellBook: readonly PricingListing[] | null;
  suggestion: PriceSuggestion | null;
  manualPrice: number | null;
}

const RELIC_SUBTYPE_RE = /\b(intact|exceptional|flawless|radiant)\b/i;

/** Mirrors inventoryMarket's private gameRef resolution for the lookup record. */
function lookupByGameRef(gameRef: string, lookup: WfmItemsLookup): WfmItemsLookup[string] | null {
  if (!gameRef) return null;
  const key = normalizeMarketName(gameRef);
  const entry = lookup[key] || null;
  if (!entry) return null;
  const mappedRef =
    typeof entry.gameRef === "string" && entry.gameRef.trim().length > 0
      ? normalizeMarketName(entry.gameRef)
      : null;
  if (mappedRef && mappedRef !== key) return null;
  return entry;
}

/** The parser types name as string but odd inventory rows have leaked other
 *  primitives (see 9bdc324f). Selection mode builds the whole queue from a
 *  reactive statement, so one bad row must not throw the rest away. */
function queueItemName(item: ParsedItem): string {
  return typeof item.name === "string" ? item.name : String(item.name ?? "");
}

/** Catalog-confirmed slugs only: a guessed slug cannot resolve to an item id at
 *  execution time, so it never enters the queue in the first place. */
export function resolveQueueSlug(item: ParsedItem, lookup: WfmItemsLookup): string | null {
  const byRef = lookupByGameRef(item.internalName, lookup);
  if (byRef?.url_name) return byRef.url_name;
  const byName = getLookupByName(queueItemName(item), lookup);
  if (byName?.url_name) return byName.url_name;
  return null;
}

function rowRank(item: ParsedItem): number | null {
  if (!isRankedGroup(item.inventoryGroup)) return null;
  return Number.isFinite(item.rank) ? Math.max(0, Math.floor(item.rank)) : 0;
}

export function relicSubtypeFor(item: ParsedItem): string | null {
  if (item.inventoryGroup !== "relics") return null;
  const match = RELIC_SUBTYPE_RE.exec(item.name);
  return match ? match[1].toLowerCase() : "intact";
}

/** Inventory rows to workbench queue rows. Pure: market data attaches later. */
export function buildQueueRows(
  items: readonly ParsedItem[],
  context: SafetyContext,
  lookup: WfmItemsLookup,
): WorkbenchQueueRow[] {
  const rows: WorkbenchQueueRow[] = [];
  for (const item of items) {
    if (item.inventoryGroup === "incomplete_sets") continue;
    const slug = resolveQueueSlug(item, lookup);
    if (!slug || isWfmExcludedSlug(slug)) continue;
    const verdict = safeToList(item, context);
    if (verdict.total <= 0) continue;
    rows.push({
      rowId: `r${rows.length}`,
      item,
      itemName: queueItemName(item),
      slug,
      rank: rowRank(item),
      verdict,
      quantity: verdict.safe,
      overrideAcknowledged: false,
      overrideAcknowledgedAt: null,
      selected: false,
      existingOrder: null,
      market: null,
      sellBook: null,
      suggestion: null,
      manualPrice: null,
    });
  }
  return rows;
}

/** Mirrors the id `buildBaseInventoryItems` puts on an inventory row, so a card
 *  the user ticked joins the queue rows built from the same ParsedItem. */
export function selectionKeyFor(item: ParsedItem): string {
  const key = item.inventoryKey;
  return typeof key === "string" && key.trim().length > 0 ? key : item.internalName;
}

/** Inventory keys the queue would accept, for the grid's per-row eligibility
 *  check. Built from `buildQueueRows` so there is one definition of sellable. */
export function eligibleSelectionKeys(
  items: readonly ParsedItem[],
  context: SafetyContext,
  lookup: WfmItemsLookup,
): Set<string> {
  const keys = new Set<string>();
  for (const row of buildQueueRows(items, context, lookup)) {
    keys.add(selectionKeyFor(row.item));
  }
  return keys;
}

/** Queue rows for the ticked inventory rows only. Every rank row of a selected
 *  item comes through, since they all share its selection key, and each starts
 *  ticked because the user already opted it in from the grid. */
export function buildSelectedQueueRows(
  items: readonly ParsedItem[],
  context: SafetyContext,
  lookup: WfmItemsLookup,
  selection: ReadonlySet<string>,
): WorkbenchQueueRow[] {
  const picked = items.filter((item) => selection.has(selectionKeyFor(item)));
  return buildQueueRows(picked, context, lookup).map((row) => ({ ...row, selected: true }));
}

/** Stable across rebuilds, unlike `rowId`, which is the build-order index. One
 *  selection key can expand to several rank rows, so the rank is part of it. */
function queueRowIdentity(row: WorkbenchQueueRow): string {
  return `${selectionKeyFor(row.item)}::${row.slug}::${row.rank ?? ""}`;
}

/** Carries a prior row's fetched market data and price edits onto its freshly
 *  built counterpart. The safety verdict is always the fresh one. */
function carryQueueRow(prior: WorkbenchQueueRow, fresh: WorkbenchQueueRow): WorkbenchQueueRow {
  const merged = setRowQuantity(
    {
      ...fresh,
      selected: prior.selected,
      market: prior.market,
      sellBook: prior.sellBook,
      suggestion: prior.suggestion,
      manualPrice: prior.manualPrice,
      overrideAcknowledged: false,
      overrideAcknowledgedAt: null,
    },
    prior.quantity,
  );
  // An acknowledgement survives only an identical verdict and amount: anything
  // the safety engine re-evaluated has to be consented to again.
  if (!prior.overrideAcknowledged) return merged;
  const same =
    merged.quantity === prior.quantity &&
    merged.verdict.safe === prior.verdict.safe &&
    merged.verdict.total === prior.verdict.total;
  if (!same) return merged;
  return {
    ...merged,
    overrideAcknowledged: true,
    overrideAcknowledgedAt: prior.overrideAcknowledgedAt,
  };
}

/** Rebuilds the queue for the current selection without discarding what the user
 *  already loaded: rows whose identity survived keep their order book, applied
 *  price and quantity, and rows the selection dropped fall away. */
export function mergeQueueRows(
  previous: readonly WorkbenchQueueRow[],
  next: readonly WorkbenchQueueRow[],
): WorkbenchQueueRow[] {
  if (previous.length === 0) return [...next];
  const byIdentity = new Map(previous.map((row) => [queueRowIdentity(row), row]));
  return next.map((row) => {
    const prior = byIdentity.get(queueRowIdentity(row));
    return prior ? carryQueueRow(prior, row) : row;
  });
}

function matchExistingOrder(row: WorkbenchQueueRow, orders: readonly WfmOrder[]): WfmOrder | null {
  return (
    orders.find(
      (order) =>
        order.orderType === "sell" &&
        order.itemUrlName === row.slug &&
        (row.rank == null || order.modRank === row.rank),
    ) ?? null
  );
}

export function attachMarketData(
  row: WorkbenchQueueRow,
  sellBook: readonly PricingListing[] | null,
  buyBook: readonly PricingListing[] | null,
  myOrders: readonly WfmOrder[],
): WorkbenchQueueRow {
  const existing = matchExistingOrder(row, myOrders);
  let market: WorkbenchMarketInfo | null = null;
  if (sellBook) {
    const activeSell = sellBook.filter((entry) => isActiveOrderStatus(entry.status));
    const lowestSell =
      activeSell.length > 0 ? Math.min(...activeSell.map((e) => e.platinum)) : null;
    const activeBuy = (buyBook ?? []).filter((entry) => isActiveOrderStatus(entry.status));
    const highestBuy = activeBuy.length > 0 ? Math.max(...activeBuy.map((e) => e.platinum)) : null;
    market = {
      lowestSell,
      highestBuy,
      activeSellers: activeSell.length,
      spread: lowestSell != null && highestBuy != null ? lowestSell - highestBuy : null,
    };
  }
  return {
    ...row,
    sellBook,
    market,
    existingOrder: existing
      ? { id: existing.id, platinum: existing.platinum, quantity: existing.quantity }
      : null,
  };
}

export function applyStrategy(
  row: WorkbenchQueueRow,
  config: StrategyConfig,
  ownUserName: string | null,
  damping?: DampingRule,
): WorkbenchQueueRow {
  if (!row.sellBook) return { ...row, suggestion: null };
  const suggestion = suggestPrice(
    config,
    {
      sellListings: row.sellBook,
      currentPrice: row.existingOrder?.platinum ?? null,
      ownUserName,
    },
    damping,
  );
  return { ...row, suggestion };
}

/** Clamped to the account total; crossing the safe count clears any previous
 *  acknowledgement so protection has to be re-confirmed for the new amount. */
export function setRowQuantity(row: WorkbenchQueueRow, quantity: number): WorkbenchQueueRow {
  const next = Math.max(0, Math.min(row.verdict.total, Math.floor(quantity)));
  const keepAck = row.overrideAcknowledged && next <= row.quantity;
  return {
    ...row,
    quantity: next,
    overrideAcknowledged: next > row.verdict.safe ? keepAck : false,
    overrideAcknowledgedAt: next > row.verdict.safe && keepAck ? row.overrideAcknowledgedAt : null,
  };
}

export function acknowledgeRowOverride(row: WorkbenchQueueRow, at: number): WorkbenchQueueRow {
  if (row.quantity <= row.verdict.safe) return row;
  return { ...row, overrideAcknowledged: true, overrideAcknowledgedAt: at };
}

export function rowNeedsOverride(row: WorkbenchQueueRow): boolean {
  return row.quantity > row.verdict.safe;
}

export function effectivePrice(row: WorkbenchQueueRow): number | null {
  if (row.manualPrice != null) return row.manualPrice;
  if (row.suggestion?.price != null) return row.suggestion.price;
  return row.existingOrder?.platinum ?? null;
}

export function rowWarnings(row: WorkbenchQueueRow): WorkbenchQueueWarning[] {
  const warnings: WorkbenchQueueWarning[] = [];
  if (row.verdict.safe === 0 && !row.overrideAcknowledged) warnings.push("fully-protected");
  if (!row.sellBook) warnings.push("no-listing-data");
  else if ((row.market?.activeSellers ?? 0) < 3) warnings.push("low-liquidity");
  if (effectivePrice(row) == null) warnings.push("no-price");
  if (rowNeedsOverride(row) && !row.overrideAcknowledged) warnings.push("override-needed");
  return warnings;
}

export function bindingReasonKeys(verdict: SafetyVerdict): string[] {
  return verdict.reservations
    .filter((reservation: SafetyReservation) => reservation.binding)
    .map((reservation) => reservation.reasonKey);
}

/** Rows that are actually executable as-is. */
function executableRows(rows: readonly WorkbenchQueueRow[]): WorkbenchQueueRow[] {
  return rows.filter(
    (row) =>
      row.selected &&
      row.quantity > 0 &&
      effectivePrice(row) != null &&
      (!rowNeedsOverride(row) || row.overrideAcknowledged),
  );
}

interface WorkbenchPlanBuild {
  plan: WorkbenchPlan;
  /** True when the selection exceeds the per-run cap; nothing was truncated. */
  overCap: boolean;
}

export function buildPlanFromRows(
  rows: readonly WorkbenchQueueRow[],
  now: number,
): WorkbenchPlanBuild {
  const eligible = executableRows(rows);
  const planRows: WorkbenchPlanRow[] = eligible.map((row) => {
    const price = effectivePrice(row) as number;
    const planRow: WorkbenchPlanRow = {
      rowId: row.rowId,
      mode: row.existingOrder ? "update" : "create",
      slug: row.slug,
      itemName: row.itemName,
      quantity: row.quantity,
      platinum: price,
    };
    if (row.rank != null) planRow.rank = row.rank;
    const subtype = relicSubtypeFor(row.item);
    if (subtype) planRow.subtype = subtype;
    if (row.existingOrder) planRow.orderId = row.existingOrder.id;
    if (rowNeedsOverride(row) && row.overrideAcknowledged) {
      planRow.override = {
        acknowledgedAt: row.overrideAcknowledgedAt ?? now,
        reasonKeys: bindingReasonKeys(row.verdict),
      };
    }
    return planRow;
  });
  return {
    plan: { planId: `plan-${now}`, createdAt: now, rows: planRows },
    overCap: planRows.length > WORKBENCH_MAX_ROWS_PER_RUN,
  };
}

/** Fresh snapshot at confirm time: verdicts are recomputed from the live
 *  safety context, never copied from what the queue was built with. */
export function captureSafetySnapshot(
  rows: readonly WorkbenchQueueRow[],
  context: SafetyContext,
  now: number,
): WorkbenchSafetySnapshot {
  const snapshot: WorkbenchSafetySnapshot = { capturedAt: now, rows: {} };
  for (const row of rows) {
    const verdict = safeToList(row.item, context);
    snapshot.rows[row.rowId] = { safe: verdict.safe, total: verdict.total };
  }
  return snapshot;
}

/** Stable key for per-item safety settings (locks, spares). */
export function rowSafetyKey(row: WorkbenchQueueRow): string {
  return safetyKeyFor(row.item);
}

interface WorkbenchTotals {
  rows: number;
  units: number;
  platinum: number;
}

export function planTotals(rows: readonly WorkbenchQueueRow[]): WorkbenchTotals {
  const eligible = executableRows(rows);
  return {
    rows: eligible.length,
    units: eligible.reduce((sum, row) => sum + row.quantity, 0),
    platinum: eligible.reduce((sum, row) => sum + row.quantity * (effectivePrice(row) ?? 0), 0),
  };
}
