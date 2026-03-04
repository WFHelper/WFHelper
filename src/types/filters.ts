export type FilterScope = "inventory" | "mastery" | "market";

export type PrimeFilterMode = "all" | "prime" | "non_prime";
export type MasteredFilterMode = "all" | "mastered" | "not_mastered";
export type YesNoFilterMode = "all" | "yes" | "no";
export type PartTypeFilterMode = "all" | "normal" | "prime";

export type SharedSortKey =
  | "name"
  | "platinum"
  | "ducats"
  | "amount"
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
  partType: PartTypeFilterMode;
  favorite: YesNoFilterMode;
  minimumPlatinum: 0 | 5 | 10 | 15;
  setComplete: YesNoFilterMode;
  equipped: YesNoFilterMode;
  leveledUp: YesNoFilterMode;
}
