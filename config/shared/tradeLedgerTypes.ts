import type { TradeEvent, TradeType } from "./statsTypes";

// Schema v2 adds provenance; absent fields mean a legacy live-captured row.
export const TRADE_EVENT_SCHEMA_VERSION = 2;

export interface LedgerQuery {
  from?: string; // "YYYY-MM-DD" inclusive
  to?: string; // "YYYY-MM-DD" inclusive
  type?: TradeType;
  text?: string; // matches item names and partner, case-insensitive
  offset?: number;
  limit?: number; // main clamps to LEDGER_QUERY_MAX_LIMIT
}

export const LEDGER_QUERY_MAX_LIMIT = 200;

export interface LedgerPage {
  events: TradeEvent[];
  total: number; // rows matching the query across live + archives
  /** Years whose archive file exists but failed to load; shown, never fatal. */
  unreadableYears: number[];
}

export interface LedgerEventPatch {
  platChange?: number;
  partner?: string;
  type?: TradeType;
  /** null clears the stored value; absent leaves it alone. */
  credits?: number | null;
  tradeTax?: number | null;
}

export interface LedgerImportRowPreview {
  kind: "parsed" | "duplicate" | "unresolved" | "rejected";
  date: string;
  summary: string;
  reason?: string;
}

export interface LedgerImportPreview {
  batchId: string;
  fileName: string;
  counts: { parsed: number; duplicates: number; unresolved: number; rejected: number };
  /** Display sample, capped by main; counts carry the full numbers. */
  rows: LedgerImportRowPreview[];
}

/** Stable failure ids. Main names the failure and the renderer owns the wording,
 *  so a German or Chinese UI never prints an English sentence from main.
 *  "cancelled" means the user closed the file dialog and is not an error. */
export type LedgerErrorCode =
  | "cancelled"
  | "noWindow"
  | "fileTooLarge"
  | "importReadFailed"
  | "noRows"
  | "invalidBatch"
  | "batchGone"
  | "importWriteFailed"
  | "invalidId"
  | "invalidPatch"
  | "rowGone"
  | "saveFailed"
  | "invalidOptions"
  | "ledgerReadFailed"
  | "exportWriteFailed";

export interface LedgerImportResult {
  applied: number;
  skippedDuplicates: number;
  error?: LedgerErrorCode;
}

export interface LedgerExportOptions {
  format: "csv" | "json";
  includePartners: boolean;
  from?: string;
  to?: string;
}
