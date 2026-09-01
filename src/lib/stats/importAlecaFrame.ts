import type { TradeEvent, TradeItem, TradeType } from "../../types/ipc.js";
import { fallbackNameFromUniqueName } from "../../../config/shared/displayName.js";
import {
  assertStatsImportRowCount,
  isDailyStatEntry,
  isValidStatsImportDate,
  MAX_TRADE_IMPORT_ROWS,
} from "../../../config/shared/statsImport.js";
import type { DailyStatEntry } from "../../../config/shared/statsTypes.js";

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function readDelta(
  r: Record<string, unknown>,
  prev: Record<string, unknown> | null,
  deltaKeys: string[],
  absKey: string,
): number {
  for (const k of deltaKeys) {
    const v = num(r[k]);
    if (v !== null) return v;
  }
  const cur = num(r[absKey]);
  const prevAbs = prev ? num(prev[absKey]) : null;
  if (cur !== null && prevAbs !== null) return cur - prevAbs;
  return 0;
}

export function normalizeAlecaFrameStats(parsed: unknown): DailyStatEntry[] {
  const p = parsed as Record<string, unknown>;
  const rawRows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(p?.generalDataPoints)
      ? (p.generalDataPoints as unknown[])
      : Array.isArray(p?.history)
        ? (p.history as unknown[])
        : Array.isArray(p?.data)
          ? (p.data as unknown[])
          : [];
  assertStatsImportRowCount(rawRows.length);

  const normalized: DailyStatEntry[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const item = rawRows[i];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const prev = i > 0 ? (rawRows[i - 1] as Record<string, unknown>) : null;

    const rawTs = typeof r.ts === "string" ? r.ts : typeof r.date === "string" ? r.date : null;
    const date = rawTs ? rawTs.slice(0, 10) : null;
    if (!isValidStatsImportDate(date)) continue;

    const entry: DailyStatEntry = {
      date,
      platDelta: readDelta(r, prev, ["platGain", "platDelta"], "plat"),
      creditsDelta: readDelta(r, prev, ["creditsDelta"], "credits"),
      endoDelta: readDelta(r, prev, ["endoDelta"], "endo"),
      ducatsDelta: readDelta(r, prev, ["ducatsDelta"], "ducats"),
      ayaDelta: readDelta(r, prev, ["ayaDelta"], "aya"),
      vitusDelta: readDelta(r, prev, ["vitusDelta"], "vitus"),
      relicsOpened: num(r.relicsOpened) ?? num(r.relicOpened) ?? 0,
      daysPlayed: num(r.daysPlayed) ?? 1,
      dailyTrades: num(r.trades) ?? num(r.dailyTrades) ?? 0,
    };
    for (const [key, source] of [
      ["absPlat", "plat"],
      ["absCredits", "credits"],
      ["absEndo", "endo"],
      ["absDucats", "ducats"],
      ["absAya", "aya"],
      ["absVitus", "vitus"],
    ] as const) {
      const value = num(r[key]) ?? num(r[source]);
      if (value !== null) entry[key] = value;
    }
    if (isDailyStatEntry(entry)) normalized.push(entry);
  }

  assertStatsImportRowCount(normalized.length);
  return normalized;
}

/** AlecaFrame writes raw ids for anything it has no name for ("/AF_Special/
 *  Imprint/Bibou"), so the ledger stores a readable name instead of the path. */
function alecaDisplayName(internalName: string, rawDisplay: string): string {
  const display = rawDisplay.trim();
  if (display && !display.startsWith("/")) return display;
  const source = internalName || display;
  return source ? fallbackNameFromUniqueName(source) : "";
}

export function parseAlecaFrameTrades(parsed: unknown): TradeEvent[] {
  if (!parsed || typeof parsed !== "object") return [];
  const p = parsed as Record<string, unknown>;
  const rawTrades: unknown[] = Array.isArray(p?.trades) ? (p.trades as unknown[]) : [];
  if (rawTrades.length === 0) return [];

  const importedTrades: TradeEvent[] = [];
  let tradeIdx = 0;
  for (const entry of rawTrades.slice(0, MAX_TRADE_IMPORT_ROWS)) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;

    if (
      typeof t.id === "string" &&
      typeof t.date === "string" &&
      (t.type === "sale" || t.type === "purchase" || t.type === "trade") &&
      Array.isArray(t.items)
    ) {
      importedTrades.push(t as unknown as TradeEvent);
      continue;
    }

    const ts = typeof t.ts === "string" ? t.ts : null;
    if (!ts) continue;

    const afType = typeof t.type === "number" ? t.type : -1;
    if (afType < 0 || afType > 2) continue;
    const tradeType: TradeType = afType === 1 ? "purchase" : afType === 0 ? "sale" : "trade";
    const totalPlat = num(t.totalPlat) ?? 0;

    const rawUser = typeof t.user === "string" ? t.user : "";
    const partner = rawUser.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]+$/u, "").trim();

    const items: TradeItem[] = [];
    const pushItems = (arr: unknown, direction: TradeItem["direction"]) => {
      if (!Array.isArray(arr)) return;
      for (const raw of arr as Record<string, unknown>[]) {
        const name = typeof raw.name === "string" ? raw.name : "";
        if (name === "/AF_Special/Platinum") continue;
        items.push({
          internalName: name,
          displayName: alecaDisplayName(
            name,
            typeof raw.displayName === "string" ? raw.displayName : "",
          ),
          count: num(raw.cnt) ?? 1,
          direction,
        });
      }
    };
    pushItems(t.tx, "given");
    pushItems(t.rx, "received");

    const id = `af-${ts}-${totalPlat}-${partner}-${tradeIdx++}`;
    importedTrades.push({
      id,
      date: ts,
      type: tradeType,
      platChange: totalPlat,
      items,
      ...(partner ? { partner } : {}),
    });
  }

  return importedTrades;
}
