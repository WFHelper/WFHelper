import { normalizeArbiNotes, normalizeArbiTags } from "./arbiTypes";

/** Tag/note hygiene is domain-agnostic, so Profit-Taker runs reuse the arbi rules. */
export const normalizePtTags = normalizeArbiTags;
export const normalizePtNotes = normalizeArbiNotes;

type PtRunSource = "live" | "imported";

export type PtRunEndReason =
  | "completed"
  | "aborted"
  | "mission-end"
  | "new-run"
  | "log-truncated"
  | "app-quit"
  | "inactivity"
  | "imported";

/** Damage types the orb shield can demand, in the reference analyser's naming. */
export type PtElement =
  | "impact"
  | "puncture"
  | "slash"
  | "cold"
  | "heat"
  | "toxin"
  | "electric"
  | "gas"
  | "viral"
  | "magnetic"
  | "radiation"
  | "corrosive"
  | "blast";

/** Positions as the player sees them; the log names them from the orb's view. */
export type PtLeg = "frontLeft" | "frontRight" | "backLeft" | "backRight";

export interface PtShieldChange {
  /** A `PtElement`, or the raw lowercased DT_ token when the game adds a new one. */
  element: string;
  seconds: number;
}

export interface PtLegBreak {
  leg: PtLeg;
  seconds: number;
}

export interface PtPhase {
  index: 1 | 2 | 3 | 4;
  totalSec: number;
  shieldSec: number;
  legSec: number;
  bodySec: number;
  pylonSec: number;
  shields: PtShieldChange[];
  legs: PtLegBreak[];
}

export interface PtRunRecord {
  /** "YYYY-MM-DD_HH-mm-ss" wall clock at run start; also the .log.gz basename. */
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  flightSec: number;
  shieldSec: number;
  legSec: number;
  bodySec: number;
  pylonSec: number;
  phases: PtPhase[];
  /** Squad member names in load order, the local player included. */
  players?: string[];
  solo: boolean;
  complete: boolean;
  bugged: boolean;
  aborted: boolean;
  hostMigration?: true;
  /** No elevator-exit line, so flight time was measured from the job-start line. */
  flightUnreliable?: true;
  /** Filename within pt-logs/, null once the raw log is deleted. */
  logFile: string | null;
  logSizeBytes: number;
  endReason: PtRunEndReason;
  source: PtRunSource;
  tags?: string[];
  notes?: string;
  /** Id of the richer record this one duplicates; absent when the run is unique. */
  duplicateOf?: string;
}

export interface PtRunsPayload {
  runs: PtRunRecord[];
  diskUsageBytes: number;
}

export interface PtImportResult {
  imported: PtRunRecord[];
  skipped: number;
}
