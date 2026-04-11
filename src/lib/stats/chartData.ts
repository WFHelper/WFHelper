/**
 * Pure chart-data computation extracted from StatsView.
 * No Svelte, i18n, or IPC dependencies — just types, constants, and functions.
 */
import type { DailyStatEntry } from "../../types/ipc.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type SessionStatKey = "platDelta" | "creditsDelta" | "endoDelta" | "ducatsDelta" | "ayaDelta";
export type ChartKey = SessionStatKey | "relicsOpened" | "daysPlayed" | "dailyTrades";

export interface BarData {
  x: number;
  y: number;
  h: number;
  value: number;
  date: string;
  positive: boolean;
}

export interface ChartResult {
  bars: BarData[];
  hasBaseline: boolean;
  bw: number;
  absLine: Array<{ x: number; y: number }> | null;
  absValues: number[];
  hasAbsData: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const BAR_H = 64;
export const BAR_H_EXPAND = 300;
export const BAR_GAP = 2;
export const SVG_W = 800;
export const MAX_BAR_W = 22;

export const TIMEFRAME_OPTIONS = [7, 14, 30, 90] as const;

/** Map chart keys to the stored absolute value field on DailyStatEntry. */
export const ABS_FIELD_MAP: Partial<Record<ChartKey, keyof DailyStatEntry>> = {
  platDelta: "absPlat",
  creditsDelta: "absCredits",
  endoDelta: "absEndo",
  ducatsDelta: "absDucats",
  ayaDelta: "absAya",
};

// ── Formatters ─────────────────────────────────────────────────────────────────

export function formatDelta(n: number, fmt: (abs: number) => string): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmt(Math.abs(n))}`;
}

export function fmtPlat(abs: number): string { return abs.toLocaleString(); }

export function fmtCredits(abs: number): string {
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return abs.toLocaleString();
}

export function fmtEndo(abs: number): string {
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return abs.toLocaleString();
}

export function fmtCount(abs: number): string { return abs.toLocaleString(); }

export const formatters: Record<ChartKey, (abs: number) => string> = {
  platDelta:    fmtPlat,
  ducatsDelta:  fmtPlat,
  ayaDelta:     fmtCount,
  creditsDelta: fmtCredits,
  endoDelta:    fmtEndo,
  relicsOpened: fmtCount,
  dailyTrades:  fmtCount,
  daysPlayed:   fmtCount,
};

export function formatAbsolute(n: number | null): string {
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function deltaClass(n: number): string {
  if (n > 0) return "delta-positive";
  if (n < 0) return "delta-negative";
  return "delta-neutral";
}

export function shortDate(iso: string): string {
  const parts = iso.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

// ── Bar chart computation ──────────────────────────────────────────────────────

/** Typed accessor for chart-keyed numeric fields on DailyStatEntry. */
function pickNumericField(entry: DailyStatEntry, key: ChartKey): number {
  switch (key) {
    case "platDelta": return entry.platDelta;
    case "creditsDelta": return entry.creditsDelta;
    case "endoDelta": return entry.endoDelta;
    case "ducatsDelta": return entry.ducatsDelta;
    case "ayaDelta": return entry.ayaDelta;
    case "relicsOpened": return entry.relicsOpened;
    case "daysPlayed": return entry.daysPlayed;
    case "dailyTrades": return entry.dailyTrades;
  }
}

export function barsForKey(key: ChartKey, hist: DailyStatEntry[], days: number, barH: number = BAR_H): ChartResult {
  const slice = hist.slice(-days);
  if (slice.length === 0) return { bars: [], hasBaseline: false, bw: 4, absLine: null, absValues: [], hasAbsData: false };

  const values: number[] = slice.map((e) => pickNumericField(e, key) ?? 0);
  const maxAbs = Math.max(1, ...values.map(Math.abs));
  const bw = Math.min(MAX_BAR_W, Math.max(2, (SVG_W - BAR_GAP * (slice.length - 1)) / slice.length));
  const hasNeg = values.some((v) => v < 0);
  const hasPos = values.some((v) => v > 0);
  const hasBaseline = hasNeg && hasPos;
  const baseline = hasBaseline ? barH / 2 : hasNeg ? 0 : barH;
  const availH = hasBaseline ? barH / 2 : barH;

  const bars: BarData[] = slice.map((entry, i) => {
    const val = values[i];
    const ratio = Math.abs(val) / maxAbs;
    const h = val === 0 ? 0 : Math.max(1, ratio * availH);
    const x = i * (bw + BAR_GAP);
    const y = val >= 0 ? baseline - h : baseline;
    return { x, y, h, value: val, date: entry.date, positive: val >= 0 };
  });

  // Build absolute-value line from stored per-day absolute values
  let absLine: Array<{ x: number; y: number }> | null = null;
  let absValues: number[] = [];
  let hasAbsData = false;
  const absField = ABS_FIELD_MAP[key];
  if (absField) {
    const rawAbs = slice.map((e) => (e[absField] as number | undefined) ?? undefined);
    const validAbs = rawAbs.filter((v): v is number => v !== undefined);
    hasAbsData = validAbs.length > 0;
    absValues = rawAbs.map((v) => v ?? NaN);
    if (validAbs.length >= 2) {
      const minV = Math.min(...validAbs);
      const maxV = Math.max(...validAbs);
      const span = (maxV - minV) || 1;
      const PAD = 0.08;
      absLine = [];
      for (let i = 0; i < slice.length; i++) {
        const v = rawAbs[i];
        if (v === undefined) continue;
        absLine.push({
          x: i * (bw + BAR_GAP) + bw / 2,
          y: barH * (1 - PAD) - ((v - minV) / span) * barH * (1 - 2 * PAD),
        });
      }
    }
  }

  return { bars, hasBaseline, bw, absLine, absValues, hasAbsData };
}

// ── Expanded-view helpers ──────────────────────────────────────────────────────

export function labelStep(days: number): number {
  if (days <= 30) return 1;
  return 3;
}

export function absYAxisTicks(absVals: number[], key: ChartKey, count: number = 5): Array<{ label: string; frac: number }> {
  const valid = absVals.filter((v) => !Number.isNaN(v));
  if (valid.length < 2) return [];
  const minV = Math.min(...valid);
  const maxV = Math.max(...valid);
  if (minV === maxV) return [{ label: formatters[key](minV), frac: 0.5 }];
  const ticks: Array<{ label: string; frac: number }> = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1); // 0 = top, 1 = bottom
    const val = maxV - frac * (maxV - minV);
    ticks.push({ label: formatters[key](val), frac });
  }
  return ticks;
}
