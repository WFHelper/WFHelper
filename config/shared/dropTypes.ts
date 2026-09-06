/** Flattened drop-table rows, shared by the main-process table cache and the
 *  renderer views that render its search results. */

/** Which upstream table the row came from, so the UI can label its source. */
export type DropKind =
  | "enemy"
  | "mission"
  | "bounty"
  | "relic"
  | "sortie"
  | "quest"
  | "syndicate"
  | "dojo"
  | "other";

export interface DropRow {
  item: string;
  /** Where it drops (e.g. "Arbitrations, Rotation C"). */
  place: string;
  rarity: string;
  chance: number;
  kind: DropKind;
}

export type DropSearchMode = "item" | "place" | "enemy";

export interface DropSearchResult {
  rows: DropRow[];
  total: number;
}
