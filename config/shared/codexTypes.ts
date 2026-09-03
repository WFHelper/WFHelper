export interface CodexScanEntry {
  /** Enemy type path as the profile reports it (e.g. /Lotus/Types/Enemies/...). */
  type: string;
  count: number;
}

/** One wiki-sourced codex entry. Everything past faction is optional because the
 *  enemy modules fill the spawn fields per entry, and many entries omit them. */
export interface CodexRequirement {
  name: string;
  scans: number;
  faction: string;
  image?: string;
  eximusScans?: number;
  planets?: string[];
  tileSets?: string[];
  missions?: string[];
  type?: string;
  description?: string;
  /** Wiki page, only when it differs from the name; may carry a #fragment. */
  link?: string;
  baseLevel?: number;
}

export type CodexScansResult =
  | { fetchedAt: number; scans: CodexScanEntry[] }
  | { error: "no-account" | "fetch-failed" | "no-data" };
