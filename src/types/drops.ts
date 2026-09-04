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
  place: string;
  rarity: string;
  chance: number;
  kind: DropKind;
}

export type DropSearchMode = "item" | "place";

export interface DropSearchResult {
  rows: DropRow[];
  total: number;
}
