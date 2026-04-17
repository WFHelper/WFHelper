import type { TradeEvent, TradeItem, TradeType } from "../../types/ipc.js";

export interface NormalizedStatEntry {
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

/**
 * Normalize AlecaFrame / generic stats JSON into a flat array of daily entries.
 * Handles both delta-style exports (platDelta) and absolute-style (plat with
 * prev-row differencing).
 */
export function normalizeAlecaFrameStats(parsed: unknown): NormalizedStatEntry[] {
  const p = parsed as Record<string, unknown>;
  const rawRows: unknown[] =
    Array.isArray(parsed)
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

    let platDelta = 0;
    if (typeof r.platGain === "number") platDelta = r.platGain;
    else if (typeof r.platDelta === "number") platDelta = r.platDelta;
    else if (typeof r.plat === "number" && prev && typeof prev.plat === "number")
      platDelta = r.plat - prev.plat;

    let creditsDelta = 0;
    if (typeof r.creditsDelta === "number") creditsDelta = r.creditsDelta;
    else if (typeof r.credits === "number" && prev && typeof prev.credits === "number")
      creditsDelta = r.credits - prev.credits;

    let endoDelta = 0;
    if (typeof r.endoDelta === "number") endoDelta = r.endoDelta;
    else if (typeof r.endo === "number" && prev && typeof prev.endo === "number")
      endoDelta = r.endo - prev.endo;

    let ducatsDelta = 0;
    if (typeof r.ducatsDelta === "number") ducatsDelta = r.ducatsDelta;
    else if (typeof r.ducats === "number" && prev && typeof prev.ducats === "number")
      ducatsDelta = r.ducats - prev.ducats;

    let ayaDelta = 0;
    if (typeof r.ayaDelta === "number") ayaDelta = r.ayaDelta;
    else if (typeof r.aya === "number" && prev && typeof prev.aya === "number")
      ayaDelta = r.aya - prev.aya;

    let relicsOpened = 0;
    if (typeof r.relicsOpened === "number") relicsOpened = r.relicsOpened;
    else if (typeof r.relicOpened === "number") relicsOpened = r.relicOpened;

    const dailyTrades =
      typeof r.trades === "number" ? r.trades : typeof r.dailyTrades === "number" ? r.dailyTrades : 0;

    const absPlat = typeof r.plat === "number" ? r.plat : undefined;
    const absCredits = typeof r.credits === "number" ? r.credits : undefined;
    const absEndo = typeof r.endo === "number" ? r.endo : undefined;
    const absDucats = typeof r.ducats === "number" ? r.ducats : undefined;
    const absAya = typeof r.aya === "number" ? r.aya : undefined;

    normalized.push({
      date,
      platDelta,
      creditsDelta,
      endoDelta,
      ducatsDelta,
      ayaDelta,
      relicsOpened,
      dailyTrades,
      absPlat,
      absCredits,
      absEndo,
      absDucats,
      absAya,
    });
  }

  return normalized;
}

/**
 * Parse AlecaFrame trade array from a stats JSON export.
 * Returns trade events ready for import via IPC.
 */
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
    const totalPlat = typeof t.totalPlat === "number" ? t.totalPlat : 0;

    // Strip trailing non-printable / PUA unicode chars from partner name
    const rawUser = typeof t.user === "string" ? t.user : "";
    const partner = rawUser.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]+$/u, "").trim();

    const txArr = Array.isArray(t.tx) ? (t.tx as Record<string, unknown>[]) : [];
    const rxArr = Array.isArray(t.rx) ? (t.rx as Record<string, unknown>[]) : [];

    const items: TradeItem[] = [];
    for (const item of txArr) {
      const name = typeof item.name === "string" ? item.name : "";
      if (name === "/AF_Special/Platinum") continue;
      items.push({
        internalName: name,
        displayName:
          typeof item.displayName === "string" ? item.displayName : (name.split("/").pop() ?? name),
        count: typeof item.cnt === "number" ? item.cnt : 1,
        direction: "given",
      });
    }
    for (const item of rxArr) {
      const name = typeof item.name === "string" ? item.name : "";
      if (name === "/AF_Special/Platinum") continue;
      items.push({
        internalName: name,
        displayName:
          typeof item.displayName === "string" ? item.displayName : (name.split("/").pop() ?? name),
        count: typeof item.cnt === "number" ? item.cnt : 1,
        direction: "received",
      });
    }

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
