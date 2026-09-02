export type FilterScope = "inventory" | "mastery" | "market" | "foundry" | "rivens";

export type PrimeFilterMode = "all" | "prime" | "non_prime";
export type MasteredFilterMode = "all" | "mastered" | "not_mastered";
export type YesNoFilterMode = "all" | "yes" | "no";
type PartTypeFilterMode = "all" | "normal" | "prime";
export type FoundryState = "claimable" | "building" | "buildable" | "missing";
/** `not_ready` drops what you could act on now (claim or build) and nothing else. */
export type FoundryStateFilterMode =
  | "all"
  | "claimable"
  | "not_ready"
  | "buildable"
  | "buildable_sets";

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
  | "complete_sets"
  | "missing_parts"
  | "parts_owned"
  | "mastery_xp";

export type SortDirection = "asc" | "desc";

/** Stable id per control of the shared filter bar. Persisted, so renaming one
    drops the stored placement of that control instead of migrating it. */
export type FilterControlId =
  | "search"
  | "prime"
  | "mastery"
  | "foundryState"
  | "vaulted"
  | "subsumed"
  | "sort"
  | "orderPlaced"
  | "mastered"
  | "spares"
  | "vaultedChips"
  | "partType"
  | "favorite"
  | "minPlatinum"
  | "minAmount"
  | "equipped"
  | "leveledUp";

/** Per-scope bar customization. Ids only: labels and values stay derived. */
export interface FilterLayout {
  order: FilterControlId[];
  hidden: FilterControlId[];
}

export interface SharedFiltersState {
  search: string;
  primeMode: PrimeFilterMode;
  masteredMode: MasteredFilterMode;
  sortBy: SharedSortKey;
  sortDirection: SortDirection;
  orderPlaced: YesNoFilterMode;
  mastered: YesNoFilterMode;
  spares: YesNoFilterMode;
  vaulted: YesNoFilterMode;
  partType: PartTypeFilterMode;
  favorite: YesNoFilterMode;
  minimumPlatinum: number;
  /** 0 = any, 2 = only items owned more than once (">1"). */
  minimumAmount: 0 | 2;
  equipped: YesNoFilterMode;
  leveledUp: YesNoFilterMode;
  subsumed: YesNoFilterMode;
  foundryState: FoundryStateFilterMode;
}
