export interface DropRow {
  item: string;
  place: string;
  rarity: string;
  chance: number;
}

export type DropSearchMode = "item" | "place";

export interface DropSearchResult {
  rows: DropRow[];
  total: number;
}
