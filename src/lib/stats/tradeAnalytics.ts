/** Pure trade-ledger analytics - no Svelte, i18n, or IPC.
 *  Cost basis is ESTIMATED: items with no recorded purchase stay unpriced
 *  rather than being booked as zero-cost profit. */
import { normalizeWfmSlug } from "../../../config/shared/wfm.js";
import { gameRefKey } from "../marketNaming.js";
import { readStorage, writeStorage } from "../persistence.js";
import type {
  ItemDbLookup,
  TradeEvent,
  TradeItem,
  TradeType,
  WfmItemsLookup,
} from "../../types/ipc.js";

type Direction = "given" | "received";

export interface DateRange {
  /** "YYYY-MM-DD" inclusive. */
  from?: string;
  to?: string;
}

export type RangePreset = "all" | "30d" | "90d" | "365d" | "ytd" | "lastYear" | "custom";

export const RANGE_PRESETS: readonly RangePreset[] = [
  "all",
  "30d",
  "90d",
  "365d",
  "ytd",
  "lastYear",
  "custom",
] as const;

export interface PlatFlow {
  platIn: number;
  platOut: number;
  /** platIn - platOut. */
  net: number;
  /** Platinum that moved in either direction. */
  volume: number;
  sales: number;
  purchases: number;
  swaps: number;
  events: number;
  /** Distinct local days that carry at least one event. */
  activeDays: number;
}

export interface ItemRollup {
  key: string;
  name: string;
  units: number;
  events: number;
  /** Platinum allocated to this item across its events. */
  platinum: number;
  /** platinum / units, or null when nothing was priced. */
  avgUnitPlat: number | null;
}

export interface CategoryRollup {
  category: string;
  soldUnits: number;
  boughtUnits: number;
  platIn: number;
  platOut: number;
  net: number;
}

export interface YearComparison {
  currentYear: number;
  previousYear: number;
  current: PlatFlow;
  previous: PlatFlow;
  /** null when the previous year has nothing to divide by. */
  netDeltaPct: number | null;
  volumeDeltaPct: number | null;
  hasPrevious: boolean;
}

interface CostBasisItem {
  key: string;
  name: string;
  soldUnits: number;
  matchedUnits: number;
  unpricedUnits: number;
  revenue: number;
  cost: number;
  margin: number;
}

export interface CostBasisResult {
  /** Always true - the label is part of the contract, never drop it in the UI. */
  estimated: true;
  soldUnits: number;
  matchedUnits: number;
  /** Sold units with no recorded acquisition: farmed, gifted, or pre-ledger. */
  unpricedUnits: number;
  matchedRevenue: number;
  matchedCost: number;
  /** matchedRevenue - matchedCost. Unpriced units are excluded on purpose. */
  estimatedMargin: number;
  estimatedMarginPct: number | null;
  /** Revenue earned on unpriced units, reported apart from the margin. */
  unpricedRevenue: number;
  /** Units given away in a swap; consumed from lots, never scored as revenue. */
  swappedUnits: number;
  /** Purchased units still unsold at the end of the range. */
  heldUnits: number;
  heldCost: number;
  perItem: CostBasisItem[];
}

interface WorthTodayRow {
  key: string;
  name: string;
  units: number;
  median: number | null;
  worth: number | null;
  realized: number;
}

export interface WorthTodayResult {
  rows: WorthTodayRow[];
  pricedUnits: number;
  unpricedUnits: number;
  /** Distinct item rows with no current price. Surface this number verbatim. */
  unpricedRows: number;
  totalWorth: number;
  realized: number;
}

const CATEGORY_OVERRIDE_KEY = "wf_analysis_category_overrides";
export const UNCATEGORIZED = "__uncategorized__";

function safeCount(item: TradeItem): number {
  const n = Number(item?.count);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** platChange is documented positive; abs() keeps a bad row from subtracting. */
function safePlat(event: TradeEvent): number {
  const n = Number(event?.platChange);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function itemsIn(event: TradeEvent, direction: Direction): TradeItem[] {
  if (!Array.isArray(event?.items)) return [];
  return event.items.filter((i) => i && i.direction === direction);
}

/** Which side of a trade the platinum pays for. Swaps price nothing. */
function pricedDirection(type: TradeType): Direction | null {
  if (type === "sale") return "given";
  if (type === "purchase") return "received";
  return null;
}

/** Stable per-item key. The market slug leads because it is the one id both live
 *  and imported rows have always carried, so a row written before uniqueName was
 *  recorded still lands in the same bucket as a newer one. */
export function itemKey(item: TradeItem): string {
  const slug = normalizeWfmSlug(item?.wfmSlug);
  if (slug) return slug;
  const internal = (item?.internalName ?? "").trim();
  if (internal) return internal;
  return (item?.displayName ?? "").trim().toLowerCase();
}

function itemName(item: TradeItem): string {
  const display = (item?.displayName ?? "").trim();
  if (display) return display;
  return (item?.internalName ?? "").trim();
}

/** Local "YYYY-MM-DD" for an ISO datetime; the ledger filters on local days. */
export function toDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftDays(now: Date, days: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - days);
  return toDayKey(d.toISOString());
}

/** Preset -> concrete bounds. "custom" keeps whatever the caller already had. */
export function resolveRangePreset(
  preset: RangePreset,
  now: Date = new Date(),
  current: DateRange = {},
): DateRange {
  const today = toDayKey(now.toISOString());
  const year = now.getFullYear();
  switch (preset) {
    case "all":
      return {};
    case "30d":
      return { from: shiftDays(now, 29), to: today };
    case "90d":
      return { from: shiftDays(now, 89), to: today };
    case "365d":
      return { from: shiftDays(now, 364), to: today };
    case "ytd":
      return { from: `${year}-01-01`, to: today };
    case "lastYear":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case "custom":
      return { ...current };
  }
}

export function filterEvents(events: TradeEvent[], range: DateRange): TradeEvent[] {
  const from = range.from || "";
  const to = range.to || "";
  if (!from && !to) return events.slice();
  return events.filter((e) => {
    const day = toDayKey(e?.date ?? "");
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

/** Stable date sort. On an equal timestamp a purchase sorts ahead of the sale it
 *  pays for, so FIFO can match it; otherwise ties keep the incoming order. */
function sortByDate(events: TradeEvent[], newestFirst: boolean): TradeEvent[] {
  const rank = (event: TradeEvent): number => (event?.type === "purchase" ? 0 : 1);
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const left = Date.parse(a.e?.date ?? "");
      const right = Date.parse(b.e?.date ?? "");
      const diff = newestFirst ? right - left : left - right;
      if (Number.isFinite(diff) && diff !== 0) return diff;
      const byType = newestFirst ? rank(b.e) - rank(a.e) : rank(a.e) - rank(b.e);
      if (byType !== 0) return byType;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

export function computeFlow(events: TradeEvent[]): PlatFlow {
  const flow: PlatFlow = {
    platIn: 0,
    platOut: 0,
    net: 0,
    volume: 0,
    sales: 0,
    purchases: 0,
    swaps: 0,
    events: events.length,
    activeDays: 0,
  };
  const days = new Set<string>();
  for (const event of events) {
    const plat = safePlat(event);
    const day = toDayKey(event?.date ?? "");
    if (day) days.add(day);
    if (event?.type === "sale") {
      flow.platIn += plat;
      flow.sales += 1;
    } else if (event?.type === "purchase") {
      flow.platOut += plat;
      flow.purchases += 1;
    } else {
      flow.swaps += 1;
    }
  }
  flow.net = flow.platIn - flow.platOut;
  flow.volume = flow.platIn + flow.platOut;
  flow.activeDays = days.size;
  return flow;
}

interface Accum {
  key: string;
  name: string;
  units: number;
  events: number;
  platinum: number;
}

function accumulate(
  map: Map<string, Accum>,
  item: TradeItem,
  units: number,
  platinum: number,
): void {
  const key = itemKey(item);
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.units += units;
    existing.events += 1;
    existing.platinum += platinum;
    if (!existing.name) existing.name = itemName(item);
    return;
  }
  map.set(key, { key, name: itemName(item), units, events: 1, platinum });
}

function rollupToList(map: Map<string, Accum>, limit: number): ItemRollup[] {
  return [...map.values()]
    .map((a) => ({
      key: a.key,
      name: a.name,
      units: a.units,
      events: a.events,
      platinum: a.platinum,
      avgUnitPlat: a.units > 0 && a.platinum > 0 ? a.platinum / a.units : null,
    }))
    .sort((a, b) => b.platinum - a.platinum || b.units - a.units || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Item rollups for one side of the book. A multi-item event splits its platinum
 * across the priced units, so per-item platinum is an allocation, not a receipt.
 */
export function topItems(events: TradeEvent[], side: "sold" | "bought", limit = 10): ItemRollup[] {
  const wantedType: TradeType = side === "sold" ? "sale" : "purchase";
  const direction: Direction = side === "sold" ? "given" : "received";
  const map = new Map<string, Accum>();
  for (const event of events) {
    if (event?.type !== wantedType) continue;
    const items = itemsIn(event, direction);
    const totalUnits = items.reduce((sum, i) => sum + safeCount(i), 0);
    if (totalUnits <= 0) continue;
    const unitPlat = safePlat(event) / totalUnits;
    for (const item of items) {
      const units = safeCount(item);
      accumulate(map, item, units, unitPlat * units);
    }
  }
  return rollupToList(map, limit);
}

/** Highest-platinum sold item, or null when nothing was sold in range. */
export function bestSeller(events: TradeEvent[]): ItemRollup | null {
  return topItems(events, "sold", 1)[0] ?? null;
}

type CategoryResolver = (item: TradeItem) => string;

export interface ItemCategoryEntry {
  key: string;
  name: string;
  resolved: string;
  overridden: boolean;
}

/** One row per distinct item in the range, for the category override editor. */
export function distinctItemCategories(
  events: TradeEvent[],
  resolve: CategoryResolver,
  overrides: Record<string, string>,
): ItemCategoryEntry[] {
  const map = new Map<string, ItemCategoryEntry>();
  for (const event of events) {
    for (const item of event?.items ?? []) {
      const key = itemKey(item);
      if (!key || map.has(key)) continue;
      map.set(key, {
        key,
        name: itemName(item),
        resolved: resolve(item),
        overridden: overrides[key] !== undefined,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Category names already in play, as suggestions for the override editor. */
export function categoryNames(entries: ItemCategoryEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.resolved && entry.resolved !== UNCATEGORIZED) seen.add(entry.resolved);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Category resolver over the item database. Trade rows come from EE.log and
 *  exports, so most carry no uniqueName: the market slug and the display name
 *  are the joins that resolve. Indices build on first miss only. */
export function makeItemCategoryResolver(
  db: ItemDbLookup,
  wfmLookup: WfmItemsLookup,
): CategoryResolver {
  let byGameRef: Map<string, string> | null = null;
  let refBySlug: Map<string, string> | null = null;

  // The item database is keyed by the exact uniqueName; WFM's gameRef does not
  // promise DE's casing, so the fallback index folds both sides.
  const categoryOf = (uniqueName: string | null | undefined): string => {
    if (!uniqueName) return "";
    const direct = db[uniqueName]?.category;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (!byGameRef) {
      byGameRef = new Map();
      for (const [key, entry] of Object.entries(db)) {
        const category = typeof entry?.category === "string" ? entry.category.trim() : "";
        if (category) byGameRef.set(gameRefKey(key), category);
      }
    }
    return byGameRef.get(gameRefKey(uniqueName)) ?? "";
  };

  const gameRefForSlug = (slug: string): string => {
    if (!refBySlug) {
      refBySlug = new Map();
      for (const entry of Object.values(wfmLookup)) {
        const key = normalizeWfmSlug(entry?.url_name);
        const ref = typeof entry?.gameRef === "string" ? entry.gameRef : "";
        if (key && ref && !refBySlug.has(key)) refBySlug.set(key, ref);
      }
    }
    return refBySlug.get(slug) ?? "";
  };

  return (item: TradeItem): string => {
    const direct = categoryOf(item?.internalName);
    if (direct) return direct;
    const slug = normalizeWfmSlug(item?.wfmSlug);
    if (slug) {
      const viaSlug = categoryOf(gameRefForSlug(slug));
      if (viaSlug) return viaSlug;
    }
    const name = (item?.displayName ?? "").trim().toLowerCase();
    if (name) {
      const viaName = categoryOf(wfmLookup[name]?.gameRef);
      if (viaName) return viaName;
    }
    return UNCATEGORIZED;
  };
}

/** Wraps a resolver so a user override always wins over the item database. */
export function withCategoryOverrides(
  base: CategoryResolver,
  overrides: Record<string, string>,
): CategoryResolver {
  return (item) => {
    const override = overrides[itemKey(item)];
    if (override) return override;
    const resolved = base(item);
    return resolved || UNCATEGORIZED;
  };
}

export function categoryRollup(
  events: TradeEvent[],
  resolveCategory: CategoryResolver,
): CategoryRollup[] {
  const map = new Map<string, CategoryRollup>();
  const bump = (category: string): CategoryRollup => {
    const existing = map.get(category);
    if (existing) return existing;
    const created: CategoryRollup = {
      category,
      soldUnits: 0,
      boughtUnits: 0,
      platIn: 0,
      platOut: 0,
      net: 0,
    };
    map.set(category, created);
    return created;
  };

  for (const event of events) {
    const direction = pricedDirection(event?.type);
    if (!direction) continue;
    const items = itemsIn(event, direction);
    const totalUnits = items.reduce((sum, i) => sum + safeCount(i), 0);
    if (totalUnits <= 0) continue;
    const unitPlat = safePlat(event) / totalUnits;
    for (const item of items) {
      const units = safeCount(item);
      const row = bump(resolveCategory(item) || UNCATEGORIZED);
      if (event.type === "sale") {
        row.soldUnits += units;
        row.platIn += unitPlat * units;
      } else {
        row.boughtUnits += units;
        row.platOut += unitPlat * units;
      }
    }
  }

  for (const row of map.values()) row.net = row.platIn - row.platOut;
  return [...map.values()].sort(
    (a, b) => b.platIn + b.platOut - (a.platIn + a.platOut) || a.category.localeCompare(b.category),
  );
}

/** Percent change against an absolute denominator; null when there is none. */
function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function yearComparison(events: TradeEvent[], now: Date = new Date()): YearComparison {
  const currentYear = now.getFullYear();
  const previousYear = currentYear - 1;
  const inYear = (year: number): TradeEvent[] =>
    filterEvents(events, { from: `${year}-01-01`, to: `${year}-12-31` });
  const current = computeFlow(inYear(currentYear));
  const previous = computeFlow(inYear(previousYear));
  return {
    currentYear,
    previousYear,
    current,
    previous,
    netDeltaPct: deltaPct(current.net, previous.net),
    volumeDeltaPct: deltaPct(current.volume, previous.volume),
    hasPrevious: previous.events > 0,
  };
}

interface Lot {
  unitCost: number;
  remaining: number;
}

interface BasisAccum {
  key: string;
  name: string;
  soldUnits: number;
  matchedUnits: number;
  unpricedUnits: number;
  revenue: number;
  cost: number;
}

function basisRow(map: Map<string, BasisAccum>, key: string, name: string): BasisAccum {
  const existing = map.get(key);
  if (existing) {
    if (!existing.name && name) existing.name = name;
    return existing;
  }
  const created: BasisAccum = {
    key,
    name,
    soldUnits: 0,
    matchedUnits: 0,
    unpricedUnits: 0,
    revenue: 0,
    cost: 0,
  };
  map.set(key, created);
  return created;
}

/** Pops up to `units` from the FIFO queue. Short queues return what they have. */
function consume(lots: Lot[], units: number): { units: number; cost: number } {
  let left = units;
  let cost = 0;
  while (left > 0 && lots.length > 0) {
    const lot = lots[0];
    const take = Math.min(left, lot.remaining);
    cost += take * lot.unitCost;
    lot.remaining -= take;
    left -= take;
    if (lot.remaining <= 0) lots.shift();
  }
  return { units: units - left, cost };
}

/**
 * FIFO cost basis over the range, oldest event first. A sale with no matching
 * purchase lot is unpriced, never zero-cost: the acquisition really is unknown.
 */
export function fifoCostBasis(events: TradeEvent[]): CostBasisResult {
  // Oldest first; sortByDate breaks a timestamp tie in favour of the purchase.
  const ordered = sortByDate(events, false);
  const lots = new Map<string, Lot[]>();
  const rows = new Map<string, BasisAccum>();
  let unpricedRevenue = 0;
  let swappedUnits = 0;

  for (const event of ordered) {
    const type = event?.type;
    if (type === "purchase") {
      const items = itemsIn(event, "received");
      const totalUnits = items.reduce((sum, i) => sum + safeCount(i), 0);
      if (totalUnits <= 0) continue;
      const unitCost = safePlat(event) / totalUnits;
      for (const item of items) {
        const key = itemKey(item);
        if (!key) continue;
        basisRow(rows, key, itemName(item));
        const queue = lots.get(key) ?? [];
        queue.push({ unitCost, remaining: safeCount(item) });
        lots.set(key, queue);
      }
      continue;
    }

    if (type === "sale") {
      const items = itemsIn(event, "given");
      const totalUnits = items.reduce((sum, i) => sum + safeCount(i), 0);
      if (totalUnits <= 0) continue;
      const unitRevenue = safePlat(event) / totalUnits;
      for (const item of items) {
        const key = itemKey(item);
        if (!key) continue;
        const units = safeCount(item);
        const row = basisRow(rows, key, itemName(item));
        const matched = consume(lots.get(key) ?? [], units);
        const unpriced = units - matched.units;
        row.soldUnits += units;
        row.matchedUnits += matched.units;
        row.unpricedUnits += unpriced;
        row.revenue += matched.units * unitRevenue;
        row.cost += matched.cost;
        unpricedRevenue += unpriced * unitRevenue;
      }
      continue;
    }

    // Swap: the item leaves inventory, so its lot is consumed, but nothing was
    // earned. Counted apart so it never lands in the margin.
    for (const item of itemsIn(event, "given")) {
      const key = itemKey(item);
      if (!key) continue;
      const units = safeCount(item);
      consume(lots.get(key) ?? [], units);
      swappedUnits += units;
    }
  }

  let heldUnits = 0;
  let heldCost = 0;
  for (const queue of lots.values()) {
    for (const lot of queue) {
      heldUnits += lot.remaining;
      heldCost += lot.remaining * lot.unitCost;
    }
  }

  const perItem: CostBasisItem[] = [...rows.values()]
    .filter((r) => r.soldUnits > 0)
    .map((r) => ({
      key: r.key,
      name: r.name,
      soldUnits: r.soldUnits,
      matchedUnits: r.matchedUnits,
      unpricedUnits: r.unpricedUnits,
      revenue: r.revenue,
      cost: r.cost,
      margin: r.revenue - r.cost,
    }))
    .sort((a, b) => b.margin - a.margin || a.name.localeCompare(b.name));

  const soldUnits = perItem.reduce((sum, r) => sum + r.soldUnits, 0);
  const matchedUnits = perItem.reduce((sum, r) => sum + r.matchedUnits, 0);
  const unpricedUnits = perItem.reduce((sum, r) => sum + r.unpricedUnits, 0);
  const matchedRevenue = perItem.reduce((sum, r) => sum + r.revenue, 0);
  const matchedCost = perItem.reduce((sum, r) => sum + r.cost, 0);
  const estimatedMargin = matchedRevenue - matchedCost;

  return {
    estimated: true,
    soldUnits,
    matchedUnits,
    unpricedUnits,
    matchedRevenue,
    matchedCost,
    estimatedMargin,
    estimatedMarginPct: matchedRevenue > 0 ? (estimatedMargin / matchedRevenue) * 100 : null,
    unpricedRevenue,
    swappedUnits,
    heldUnits,
    heldCost,
    perItem,
  };
}

/** Current median for an item, or null when the price cache has no answer. */
type PriceResolver = (item: TradeItem) => number | null;

/**
 * What the sold units would fetch at today's median. Items the price cache
 * cannot answer for stay null and are counted, never treated as worth 0.
 */
export function worthToday(
  events: TradeEvent[],
  resolvePrice: PriceResolver,
  limit = 25,
): WorthTodayResult {
  const map = new Map<string, { row: WorthTodayRow; item: TradeItem }>();
  for (const event of events) {
    if (event?.type !== "sale") continue;
    const items = itemsIn(event, "given");
    const totalUnits = items.reduce((sum, i) => sum + safeCount(i), 0);
    if (totalUnits <= 0) continue;
    const unitPlat = safePlat(event) / totalUnits;
    for (const item of items) {
      const key = itemKey(item);
      if (!key) continue;
      const units = safeCount(item);
      const existing = map.get(key);
      if (existing) {
        existing.row.units += units;
        existing.row.realized += unitPlat * units;
        continue;
      }
      map.set(key, {
        item,
        row: {
          key,
          name: itemName(item),
          units,
          median: null,
          worth: null,
          realized: unitPlat * units,
        },
      });
    }
  }

  let pricedUnits = 0;
  let unpricedUnits = 0;
  let unpricedRows = 0;
  let totalWorth = 0;
  let realized = 0;

  for (const entry of map.values()) {
    const median = resolvePrice(entry.item);
    const row = entry.row;
    realized += row.realized;
    if (median != null && Number.isFinite(median)) {
      row.median = median;
      row.worth = median * row.units;
      pricedUnits += row.units;
      totalWorth += row.worth;
    } else {
      unpricedUnits += row.units;
      unpricedRows += 1;
    }
  }

  const rows = [...map.values()]
    .map((e) => e.row)
    .sort((a, b) => (b.worth ?? -1) - (a.worth ?? -1) || b.units - a.units)
    .slice(0, limit);

  return { rows, pricedUnits, unpricedUnits, unpricedRows, totalWorth, realized };
}

/** Whole platinum with locale separators; fractions come from allocation only. */
export function formatPlat(value: number, locale: string): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString(locale);
}

/** Signed percentage, or null so callers render their own "not comparable". */
export function formatPct(value: number | null, locale: string): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export function loadCategoryOverrides(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readStorage(CATEGORY_OVERRIDE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCategoryOverrides(overrides: Record<string, string>): void {
  writeStorage(CATEGORY_OVERRIDE_KEY, JSON.stringify(overrides));
}
