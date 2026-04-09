/**
 * Shared stats types used by both main-process (services/statsTracker.ts)
 * and renderer (src/types/ipc.ts).
 *
 * Single source of truth — do not duplicate these interfaces elsewhere.
 */

export interface DailyStatEntry {
  date: string;           // "YYYY-MM-DD"
  platDelta: number;      // net plat change this session/day
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;    // net Void Ducat change (DUCTCREDITS)
  ayaDelta: number;       // net Aya (PrimeTokens) change
  relicsOpened: number;   // relics consumed (LevelKeys net decrease, ≥0)
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
