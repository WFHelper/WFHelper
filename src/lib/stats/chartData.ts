/** Pure chart-data computation - no Svelte, i18n, or IPC. */
import { localDayKey } from "../../../config/shared/dayKey.js";
import type { DailyStatEntry } from "../../types/ipc.js";

export type SessionStatKey =
  | "platDelta"
  | "creditsDelta"
  | "endoDelta"
  | "ducatsDelta"
  | "ayaDelta"
  | "vitusDelta";
export type ChartKey = SessionStatKey | "relicsOpened" | "dailyTrades";

interface BarData {
  x: number;
  y: number;
  h: number;
  value: number;
  date: string;
  positive: boolean;
}

interface YTick {
  label: string;
  value: number;
  /** Fraction 0 = top of SVG, 1 = bottom */
  yFrac: number;
}

export interface ChartResult {
  bars: BarData[];
  hasBaseline: boolean;
  bw: number;
  absLine: Array<{ x: number; y: number; idx: number }> | null;
  absValues: number[];
  hasAbsData: boolean;
  /** Per-bar flag: true if this day had a real history entry (not gap-filled). */
  realData: boolean[];
  yTicks: YTick[];
  /** The nice ceiling used for scaling (0 -> niceMax). */
  niceMax: number;
}

export const BAR_H = 64;
export const BAR_H_EXPAND = 300;
const BAR_GAP = 2;
export const SVG_W = 800;

export const TIMEFRAME_OPTIONS = [7, 14, 30, 90] as const;

/** Map chart keys to the stored absolute value field on DailyStatEntry. */
const ABS_FIELD_MAP: Partial<Record<ChartKey, keyof DailyStatEntry>> = {
  platDelta: "absPlat",
  creditsDelta: "absCredits",
  endoDelta: "absEndo",
  ducatsDelta: "absDucats",
  ayaDelta: "absAya",
  vitusDelta: "absVitus",
};

type ValueFormatter = (abs: number, locale: string) => string;

export function formatDelta(n: number, fmt: ValueFormatter, locale: string): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmt(Math.abs(n), locale)}`;
}

function fixed(value: number, digits: number, locale: string): string {
  return value.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPlat(abs: number, locale: string): string {
  return abs.toLocaleString(locale);
}

function fmtCredits(abs: number, locale: string): string {
  if (abs >= 1_000_000) return `${fixed(abs / 1_000_000, 2, locale)}M`;
  if (abs >= 1_000) return `${fixed(abs / 1_000, 1, locale)}k`;
  return abs.toLocaleString(locale);
}

function fmtEndo(abs: number, locale: string): string {
  if (abs >= 1_000) return `${fixed(abs / 1_000, 1, locale)}k`;
  return abs.toLocaleString(locale);
}

function fmtCount(abs: number, locale: string): string {
  return abs.toLocaleString(locale);
}

export const formatters: Record<ChartKey, ValueFormatter> = {
  platDelta: fmtPlat,
  ducatsDelta: fmtPlat,
  ayaDelta: fmtCount,
  creditsDelta: fmtCredits,
  endoDelta: fmtEndo,
  vitusDelta: fmtCount,
  relicsOpened: fmtCount,
  dailyTrades: fmtCount,
};

export function formatAbsolute(n: number | null, locale: string): string {
  if (n === null) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${fixed(n / 1_000_000, 2, locale)}M`;
  if (abs >= 100_000) return `${fixed(n / 1_000, 1, locale)}k`;
  return n.toLocaleString(locale);
}

export function shortDate(iso: string, locale: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { day: "numeric", month: "numeric", timeZone: "UTC" });
}

/** Compact SI tick label: 1.2M / 3.4K / raw. */
function fmtTickSI(value: number, locale: string): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${fixed(value / 1_000_000, 1, locale)}M`;
  if (abs >= 1_000) return `${fixed(value / 1_000, 1, locale)}K`;
  return value.toLocaleString(locale);
}

/** Round up to a "nice" number for axis scaling (1, 2, 5 multiples of powers of 10). */
function niceRoundUp(val: number): number {
  if (val <= 0) return 1;
  const exp = Math.floor(Math.log10(val));
  const base = Math.pow(10, exp);
  const frac = val / base;
  if (frac <= 1) return base;
  if (frac <= 2) return 2 * base;
  if (frac <= 5) return 5 * base;
  return 10 * base;
}

/** Compute nice Y-axis ticks from 0 to a nice ceiling above maxVal. */
function computeNiceTicks(
  maxVal: number,
  locale: string,
  targetCount: number = 5,
): { ticks: YTick[]; niceMax: number } {
  if (maxVal <= 0) {
    return { ticks: [{ label: "0", value: 0, yFrac: 1 }], niceMax: 1 };
  }
  // For small integer values, use step=1 so we don't get 0.2, 0.4, etc.
  let niceStep = niceRoundUp(maxVal / targetCount);
  if (maxVal <= targetCount) niceStep = 1;
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;
  const ticks: YTick[] = [];
  const PAD = 0.02;
  for (let v = 0; v <= niceMax; v += niceStep) {
    // 0 at bottom (yFrac close to 1), niceMax at top (yFrac close to 0)
    const yFrac = PAD + (1 - v / niceMax) * (1 - 2 * PAD);
    ticks.push({ label: fmtTickSI(v, locale), value: v, yFrac });
  }
  return { ticks, niceMax };
}

/** Typed accessor for chart-keyed numeric fields on DailyStatEntry. */
function pickNumericField(entry: DailyStatEntry, key: ChartKey): number {
  switch (key) {
    case "platDelta":
      return entry.platDelta;
    case "creditsDelta":
      return entry.creditsDelta;
    case "endoDelta":
      return entry.endoDelta;
    case "ducatsDelta":
      return entry.ducatsDelta;
    case "ayaDelta":
      return entry.ayaDelta;
    case "vitusDelta":
      return entry.vitusDelta ?? 0;
    case "relicsOpened":
      return entry.relicsOpened;
    case "dailyTrades":
      return entry.dailyTrades;
  }
}

/** Generate all YYYY-MM-DD strings from startDate to today (inclusive). */
function allCalendarDays(startIso: string): string[] {
  const result: string[] = [];
  const d = new Date(startIso + "T00:00:00");
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  while (d <= today) {
    result.push(localDayKey(d));
    d.setDate(d.getDate() + 1);
  }
  return result;
}

export function barsForKey(
  key: ChartKey,
  hist: DailyStatEntry[],
  days: number,
  barH: number = BAR_H,
  locale: string = "en",
): ChartResult {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = localDayKey(cutoff);
  const calendarDays = allCalendarDays(cutoffStr);
  if (calendarDays.length === 0)
    return {
      bars: [],
      hasBaseline: false,
      bw: 4,
      absLine: null,
      absValues: [],
      hasAbsData: false,
      realData: [],
      yTicks: [],
      niceMax: 0,
    };

  // Index entries by date; newest pre-window entry seeds the carry-in.
  const entryMap = new Map<string, DailyStatEntry>();
  let carryIn: DailyStatEntry | null = null;
  for (const e of hist) {
    if (e.date >= cutoffStr) entryMap.set(e.date, e);
    else if (!carryIn || e.date > carryIn.date) carryIn = e;
  }

  const realData: boolean[] = [];
  let values: number[] = [];
  const absField = ABS_FIELD_MAP[key];
  const rawAbs: (number | undefined)[] = [];

  for (const day of calendarDays) {
    const entry = entryMap.get(day);
    realData.push(!!entry);
    values.push(entry ? (pickNumericField(entry, key) ?? 0) : 0);
    rawAbs.push(
      absField && entry ? ((entry[absField] as number | undefined) ?? undefined) : undefined,
    );
  }

  // Derive deltas from consecutive abs values when the recorded delta is 0
  if (absField) {
    for (let i = 1; i < values.length; i++) {
      if (values[i] === 0 && rawAbs[i] !== undefined && rawAbs[i - 1] !== undefined) {
        const derived = (rawAbs[i] as number) - (rawAbs[i - 1] as number);
        if (derived !== 0) values[i] = derived;
      }
    }
  }
  const maxAbs = Math.max(1, ...values.map(Math.abs));
  const n = calendarDays.length;
  // Always fill the full SVG width so bars align with the date labels below
  const bw = Math.max(2, (SVG_W - BAR_GAP * (n - 1)) / n);
  const hasNeg = values.some((v) => v < 0);
  const hasPos = values.some((v) => v > 0);
  const hasBaseline = hasNeg && hasPos;

  // For bar-only charts, pre-compute niceMax so bars scale to the Y-axis
  let earlyNiceMax = 0;
  if (!absField) {
    const maxV = Math.max(...values);
    if (maxV > 0) {
      const targetTicks = barH >= BAR_H_EXPAND ? 8 : 5;
      earlyNiceMax = computeNiceTicks(maxV, locale, targetTicks).niceMax;
    }
  }

  // Scale bars: bar-only charts use niceMax for proper Y-axis alignment
  const barScale = earlyNiceMax > 0 ? earlyNiceMax : maxAbs;
  const PAD = 0.02;
  const baseline = hasBaseline ? barH / 2 : hasNeg ? 0 : barH;
  const availH = hasBaseline ? barH / 2 : barH;

  const bars: BarData[] = calendarDays.map((day, i) => {
    const val = values[i];
    if (earlyNiceMax > 0 && !hasBaseline) {
      // Bar-only: scale from 0 (bottom) to niceMax (top) with PAD
      const ratio = Math.abs(val) / earlyNiceMax;
      const drawH = val === 0 ? 0 : Math.max(1, ratio * barH * (1 - 2 * PAD));
      const x = i * (bw + BAR_GAP);
      const bottomY = barH * (1 - PAD);
      const y = val >= 0 ? bottomY - drawH : bottomY;
      return { x, y, h: drawH, value: val, date: day, positive: val >= 0 };
    }
    // Delta charts: scale bars independently
    const ratio = Math.abs(val) / barScale;
    const h = val === 0 ? 0 : Math.max(1, ratio * availH);
    const x = i * (bw + BAR_GAP);
    const y = val >= 0 ? baseline - h : baseline;
    return { x, y, h, value: val, date: day, positive: val >= 0 };
  });

  let absLine: Array<{ x: number; y: number; idx: number }> | null = null;
  let absValues: number[] = [];
  let hasAbsData = false;

  let yTicks: YTick[] = [];
  let niceMax = 0;

  if (absField) {
    // Carry forward the last known absolute value so the line extends across gaps
    let lastKnown: number | undefined = carryIn
      ? ((carryIn[absField] as number | undefined) ?? undefined)
      : undefined;
    for (let i = 0; i < rawAbs.length; i++) {
      if (rawAbs[i] !== undefined) lastKnown = rawAbs[i];
      else if (lastKnown !== undefined) rawAbs[i] = lastKnown;
    }
    const validAbs = rawAbs.filter((v): v is number => v !== undefined);
    hasAbsData = validAbs.length > 0;
    absValues = rawAbs.map((v) => v ?? NaN);
    // >= 1: a newly tracked stat has only today's balance - still show it
    if (validAbs.length >= 1) {
      const maxV = Math.max(...validAbs);
      const targetTicks = barH >= BAR_H_EXPAND ? 8 : 5;
      const nice = computeNiceTicks(maxV, locale, targetTicks);
      yTicks = nice.ticks;
      niceMax = nice.niceMax;

      const PAD = 0.02;
      absLine = [];
      for (let i = 0; i < calendarDays.length; i++) {
        const v = rawAbs[i];
        if (v === undefined) continue;
        // Scale: 0 -> bottom (1-PAD), niceMax -> top (PAD)
        const yFrac = PAD + (1 - v / niceMax) * (1 - 2 * PAD);
        absLine.push({
          x: i * (bw + BAR_GAP) + bw / 2,
          y: yFrac * barH,
          idx: i,
        });
      }
    }
  } else {
    // Bar-only charts (relicsOpened, dailyTrades): Y-axis from bar values
    if (earlyNiceMax > 0) {
      const targetTicks = barH >= BAR_H_EXPAND ? 8 : 5;
      const nice = computeNiceTicks(Math.max(...values), locale, targetTicks);
      yTicks = nice.ticks;
      niceMax = nice.niceMax;
    }
  }

  return { bars, hasBaseline, bw, absLine, absValues, hasAbsData, realData, yTicks, niceMax };
}

export function labelStep(days: number): number {
  if (days <= 7) return 1;
  if (days <= 14) return 2;
  if (days <= 30) return 5;
  return 10;
}

/** Divergent bar geometry for the analysis flow panels. The month and the day
 *  chart draw the same bars off different fields, so only the shape lives here
 *  and each component keeps its own markup, labels and tooltips. */
export const FLOW_SLOT = 10;
export const FLOW_BAR = 6.5;
export const FLOW_HEIGHT = 100;

interface FlowAxis {
  /** viewBox width for `count` slots. */
  width: number;
  /** Y of the zero line; the full height when there is nothing to plot. */
  zeroY: number;
  /** up + down; 0 means no bars. */
  span: number;
}

export function flowAxis(count: number, up: number, down: number): FlowAxis {
  const width = Math.max(1, count) * FLOW_SLOT;
  const span = up + down;
  if (span <= 0) return { width, zeroY: FLOW_HEIGHT, span: 0 };
  return { width, zeroY: (up / span) * FLOW_HEIGHT, span };
}

export function flowBarX(index: number): number {
  return index * FLOW_SLOT + (FLOW_SLOT - FLOW_BAR) / 2;
}

/** A tiny value still needs a visible sliver, so every bar keeps 1 unit. */
export function flowBarHeight(value: number, span: number): number {
  if (span <= 0) return 0;
  return Math.max(1, (Math.abs(value) / span) * FLOW_HEIGHT);
}
