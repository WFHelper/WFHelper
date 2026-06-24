/**
 * Pure chart-data computation extracted from StatsView.
 * No Svelte, i18n, or IPC dependencies - just types, constants, and functions.
 */
import type { DailyStatEntry } from "../../types/ipc.js";


export type SessionStatKey = "platDelta" | "creditsDelta" | "endoDelta" | "ducatsDelta" | "ayaDelta";
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
  /** The nice ceiling used for scaling (0 → niceMax). */
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
};


export function formatDelta(n: number, fmt: (abs: number) => string): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmt(Math.abs(n))}`;
}

function fmtPlat(abs: number): string { return abs.toLocaleString(); }

function fmtCredits(abs: number): string {
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return abs.toLocaleString();
}

function fmtEndo(abs: number): string {
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return abs.toLocaleString();
}

function fmtCount(abs: number): string { return abs.toLocaleString(); }

export const formatters: Record<ChartKey, (abs: number) => string> = {
  platDelta:    fmtPlat,
  ducatsDelta:  fmtPlat,
  ayaDelta:     fmtCount,
  creditsDelta: fmtCredits,
  endoDelta:    fmtEndo,
  relicsOpened: fmtCount,
  dailyTrades:  fmtCount,
};

export function formatAbsolute(n: number | null): string {
  if (n === null) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 100_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function shortDate(iso: string): string {
  const parts = iso.split("-");
  return `${parseInt(parts[2])}.${parseInt(parts[1])}`;
}

/**
 * Compact SI tick label: >=1M -> "X.XM", >=1K -> "X.XK", else raw number.
 */
function fmtTickSI(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
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
function computeNiceTicks(maxVal: number, targetCount: number = 5): { ticks: YTick[]; niceMax: number } {
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
    ticks.push({ label: fmtTickSI(v), value: v, yFrac });
  }
  return { ticks, niceMax };
}


/** Typed accessor for chart-keyed numeric fields on DailyStatEntry. */
function pickNumericField(entry: DailyStatEntry, key: ChartKey): number {
  switch (key) {
    case "platDelta": return entry.platDelta;
    case "creditsDelta": return entry.creditsDelta;
    case "endoDelta": return entry.endoDelta;
    case "ducatsDelta": return entry.ducatsDelta;
    case "ayaDelta": return entry.ayaDelta;
    case "relicsOpened": return entry.relicsOpened;
    case "dailyTrades": return entry.dailyTrades;
  }
}

/** Format YYYY-MM-DD from a local Date. */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Generate all YYYY-MM-DD strings from startDate to today (inclusive). */
function allCalendarDays(startIso: string): string[] {
  const result: string[] = [];
  const d = new Date(startIso + "T00:00:00");
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  while (d <= today) {
    result.push(localDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return result;
}

export function barsForKey(key: ChartKey, hist: DailyStatEntry[], days: number, barH: number = BAR_H): ChartResult {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = localDateStr(cutoff);
  const calendarDays = allCalendarDays(cutoffStr);
  if (calendarDays.length === 0) return { bars: [], hasBaseline: false, bw: 4, absLine: null, absValues: [], hasAbsData: false, realData: [], yTicks: [], niceMax: 0 };

  // Index real entries by date for fast lookup
  const entryMap = new Map<string, DailyStatEntry>();
  for (const e of hist) {
    if (e.date >= cutoffStr) entryMap.set(e.date, e);
  }

  const realData: boolean[] = [];
  let values: number[] = [];
  const absField = ABS_FIELD_MAP[key];
  const rawAbs: (number | undefined)[] = [];

  for (const day of calendarDays) {
    const entry = entryMap.get(day);
    realData.push(!!entry);
    values.push(entry ? (pickNumericField(entry, key) ?? 0) : 0);
    rawAbs.push(absField && entry ? ((entry[absField] as number | undefined) ?? undefined) : undefined);
  }

  // Fallback: derive deltas from absolute values for entries where delta is 0
  // but consecutive abs values show a change
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
      earlyNiceMax = computeNiceTicks(maxV, targetTicks).niceMax;
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
    let lastKnown: number | undefined;
    for (let i = 0; i < rawAbs.length; i++) {
      if (rawAbs[i] !== undefined) lastKnown = rawAbs[i];
      else if (lastKnown !== undefined) rawAbs[i] = lastKnown;
    }
    const validAbs = rawAbs.filter((v): v is number => v !== undefined);
    hasAbsData = validAbs.length > 0;
    absValues = rawAbs.map((v) => v ?? NaN);
    if (validAbs.length >= 2) {
      const maxV = Math.max(...validAbs);
      const targetTicks = barH >= BAR_H_EXPAND ? 8 : 5;
      const nice = computeNiceTicks(maxV, targetTicks);
      yTicks = nice.ticks;
      niceMax = nice.niceMax;

      const PAD = 0.02;
      absLine = [];
      for (let i = 0; i < calendarDays.length; i++) {
        const v = rawAbs[i];
        if (v === undefined) continue;
        // Scale: 0 → bottom (1-PAD), niceMax → top (PAD)
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
      const nice = computeNiceTicks(Math.max(...values), targetTicks);
      yTicks = nice.ticks;
      niceMax = nice.niceMax;
    }
  }

  return { bars, hasBaseline, bw, absLine, absValues, hasAbsData, realData, yTicks, niceMax };
}


export function labelStep(days: number): number {
  if (days <= 7) return 1;
  if (days <= 14) return 2;
  if (days <= 30) return 2;
  return 5;
}
