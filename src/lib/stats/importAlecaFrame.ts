import type { TradeEvent, TradeItem, TradeType } from "../../types/ipc.js";

interface NormalizedStatEntry {
  date: string;
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;
  ayaDelta: number;
  relicsOpened: number;
  dailyTrades: number;
  absPlat?: number | undefined;
  absCredits?: number | undefined;
  absEndo?: number | undefined;
  absDucats?: number | undefined;
  absAya?: number | undefined;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Explicit delta fields win; otherwise diff the absolute field against the previous row. */
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

/** Normalize stats JSON to daily entries - delta-style or absolute-style rows. */
export function normalizeAlecaFrameStats(parsed: unknown): NormalizedStatEntry[] {
  const p = parsed as Record<string, unknown>;
  const rawRows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(p?.generalDataPoints)
      ? (p.generalDataPoints as unknown[])
      : Array.isArray(p?.data)
        ? (p.data as unknown[])
        : [];

  const normalized: NormalizedStatEntry[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const item = rawRows[i];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const prev = i > 0 ? (rawRows[i - 1] as Record<string, unknown>) : null;

    const rawTs = typeof r.ts === "string" ? r.ts : typeof r.date === "string" ? r.date : null;
    const date = rawTs ? rawTs.slice(0, 10) : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    normalized.push({
      date,
      platDelta: readDelta(r, prev, ["platGain", "platDelta"], "plat"),
      creditsDelta: readDelta(r, prev, ["creditsDelta"], "credits"),
      endoDelta: readDelta(r, prev, ["endoDelta"], "endo"),
      ducatsDelta: readDelta(r, prev, ["ducatsDelta"], "ducats"),
      ayaDelta: readDelta(r, prev, ["ayaDelta"], "aya"),
      relicsOpened: num(r.relicsOpened) ?? num(r.relicOpened) ?? 0,
      dailyTrades: num(r.trades) ?? num(r.dailyTrades) ?? 0,
      absPlat: num(r.plat) ?? undefined,
      absCredits: num(r.credits) ?? undefined,
      absEndo: num(r.endo) ?? undefined,
      absDucats: num(r.ducats) ?? undefined,
      absAya: num(r.aya) ?? undefined,
    });
  }

  return normalized;
}

/** Parse the trade array from a stats JSON export. */
export function parseAlecaFrameTrades(parsed: unknown): TradeEvent[] {
  if (!parsed || typeof parsed !== "object") return [];
  const p = parsed as Record<string, unknown>;
  const rawTrades: unknown[] = Array.isArray(p?.trades) ? (p.trades as unknown[]) : [];
  if (rawTrades.length === 0) return [];

  const importedTrades: TradeEvent[] = [];
  let tradeIdx = 0;
  for (const entry of rawTrades) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;

    const ts = typeof t.ts === "string" ? t.ts : null;
    if (!ts) continue;

    const afType = typeof t.type === "number" ? t.type : -1;
    // 0 = sale, 1 = purchase, 2 = trade (item swap / gift)
    if (afType < 0 || afType > 2) continue;
    const tradeType: TradeType = afType === 1 ? "purchase" : afType === 0 ? "sale" : "trade";
    const totalPlat = num(t.totalPlat) ?? 0;

    // Strip trailing non-printable / PUA unicode chars from partner name
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
          displayName:
            typeof raw.displayName === "string" ? raw.displayName : (name.split("/").pop() ?? name),
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
