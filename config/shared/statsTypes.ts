/**
 * Shared stats/trade types used by both main-process and renderer.
 *
 * Single source of truth - do not duplicate these types elsewhere.
 */

/** Classification of a trade event. */
export type TradeType = "sale" | "purchase" | "trade";

/** Download stage for the API helper binary. */
export type DownloadStage = "resolving" | "downloading" | "done" | "error";

/** Direction of an item in a trade. */
export type TradeDirection = "given" | "received";


export interface TradeItem {
  internalName: string;
  displayName: string;
  count: number;
  direction: TradeDirection;
  wfmSlug?: string;
  wfmThumb?: string;
}

export interface TradeEvent {
  id: string;
  date: string;            // ISO datetime
  type: TradeType;
  platChange: number;      // always positive (0 for pure item swaps)
  items: TradeItem[];
  partner?: string;        // trading partner username (best-effort from EE.log)
  wfmClosed?: boolean;     // true when a WFM order was auto-closed for this trade
}


export interface DailyStatEntry {
  date: string;           // "YYYY-MM-DD"
  platDelta: number;      // net plat change this session/day
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;    // net Void Ducat change (MiscItems/PrimeBucks)
  ayaDelta: number;       // net Aya (PrimeTokens) change
  relicsOpened: number;   // relics consumed (LevelKeys net decrease, >=0)
  daysPlayed: number;     // 1 = played; 0 = no inventory data (imported gap)
  dailyTrades: number;    // number of trades detected or imported for this day
  absPlat?: number;       // absolute platinum balance at end of day
  absCredits?: number;    // absolute credits balance at end of day
  absEndo?: number;       // absolute endo balance at end of day
  absDucats?: number;     // absolute ducats balance at end of day
  absAya?: number;        // absolute aya balance at end of day
}

export interface SessionStats {
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;
  ayaDelta: number;
  currentPlat: number | null;
  currentCredits: number | null;
  currentEndo: number | null;
  currentDucats: number | null;
  currentAya: number | null;
  hasData: boolean;
}
