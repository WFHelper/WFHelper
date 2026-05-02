export type FilterScope = "inventory" | "mastery" | "market" | "foundry" | "rivens";

export type PrimeFilterMode = "all" | "prime" | "non_prime";
export type MasteredFilterMode = "all" | "mastered" | "not_mastered";
export type YesNoFilterMode = "all" | "yes" | "no";
type PartTypeFilterMode = "all" | "normal" | "prime";

export type SharedSortKey =
  | "name"
  | "owned"
  | "platinum"
  | "ducats"
  | "amount"
  | "count"
  | "time"
  | "disposition"
  | "rerolls"
  | "grade"
  | "ducatonator"
  | "complete_sets";

export type SortDirection = "asc" | "desc";

export interface SharedFiltersState {
  search: string;
  primeMode: PrimeFilterMode;
  masteredMode: MasteredFilterMode;
  sortBy: SharedSortKey;
  sortDirection: SortDirection;
  orderPlaced: YesNoFilterMode;
  vaulted: YesNoFilterMode;
  partType: PartTypeFilterMode;
  favorite: YesNoFilterMode;
  minimumPlatinum: 0 | 5 | 10 | 15;
  setComplete: YesNoFilterMode;
  equipped: YesNoFilterMode;
  leveledUp: YesNoFilterMode;
}
