import type { MessageKey } from "./i18n.js";
import type {
  FilterControlId,
  FilterScope,
  FoundryState,
  SharedFiltersState,
  SortDirection,
} from "../types/filters.js";
import type { MasteryStatus, PartType } from "../types/inventory.js";

// Value-like sorts read best-first; name/tier/time and "parts to complete"
// read ascending. Every view derives its default direction from this.
const DESCENDING_DEFAULT_SORT_KEYS = new Set<string>([
  "platinum",
  "ducats",
  "amount",
  "count",
  "owned",
  "disposition",
  "rerolls",
  "grade",
  "attr_grade",
  "ducatonator",
  "complete_sets",
  "mastery_xp",
  "parts_owned",
  "ev",
  "ducat",
]);

export function defaultSortDirection(sortBy: string): SortDirection {
  return DESCENDING_DEFAULT_SORT_KEYS.has(sortBy) ? "desc" : "asc";
}

interface FilterableItem {
  name: string;
  displayName?: string;
  category?: string;
  categoryLabel?: string;
  internalName?: string;
  keywords?: string[];
  isPrime?: boolean;
  rank?: number;
  maxRank?: number;
  status?: MasteryStatus | string;
  platinum?: number | null;
  ducats?: number | null;
  amount?: number | null;
  combinedAmount?: number | null;
  ducatonator?: number | null;
  completeSets?: number | boolean | null;
  missingParts?: number | null;
  /** Distinct component types owned; null when the item has no parts to track. */
  partsOwned?: number | null;
  orderPlaced?: boolean;
  /** Both undefined when nothing masterable needs the item (mods, resources). */
  parentMastered?: boolean;
  spare?: boolean;
  vaulted?: boolean;
  owned?: boolean;
  currentlyOwned?: boolean;
  partType?: PartType;
  favorite?: boolean;
  equipped?: boolean;
  leveledUp?: boolean;
  subsumed?: boolean | undefined;
  count?: number | null;
  time?: number | null;
  disposition?: number | null;
  rerolls?: number | null;
  grade?: string | number | null;
  gradeRank?: number | null;
  /** Second grade axis (riven attribute quality); the caller supplies the rank. */
  attrGradeRank?: number | null;
  masteryXpRemaining?: number | null;
  /** Undefined when no foundry state applies (already owned and mastered). */
  foundryState?: FoundryState | undefined;
  /** A blueprint for a part of something bigger, rather than the thing itself. */
  looseComponent?: boolean;
}

const GRADE_ORDER: Record<string, number> = {
  S: 6,
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  F: 1,
};

function isMastered(item: FilterableItem): boolean {
  if (item.status) return item.status === "mastered";
  if (typeof item.rank === "number" && typeof item.maxRank === "number") {
    return item.maxRank > 0 && item.rank >= item.maxRank;
  }
  return false;
}

function includesQuery(field: string | undefined, query: string): boolean {
  return typeof field === "string" && field.toLowerCase().includes(query);
}

/** The one search rule for every row shape; sparse rows (resources) just miss fields. */
export function matchesSearch(item: FilterableItem, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;

  // Both names: the list shows the localized one but traders search in English.
  // Field by field rather than an array so a thousands-row list allocates nothing.
  if (includesQuery(item.name, query)) return true;
  if (includesQuery(item.displayName, query)) return true;
  if (includesQuery(item.category, query)) return true;
  if (includesQuery(item.categoryLabel, query)) return true;
  if (includesQuery(item.internalName, query)) return true;
  if (!Array.isArray(item.keywords)) return false;
  return item.keywords.some((keyword) => includesQuery(keyword, query));
}

function matchesYesNo(
  mode: SharedFiltersState["orderPlaced"],
  value: boolean | undefined,
): boolean {
  if (mode === "all") return true;
  if (mode === "yes") return value === true;
  return value !== true;
}

function matchesPartType(item: FilterableItem, mode: SharedFiltersState["partType"]): boolean {
  if (mode === "all") return true;
  const partType = item.partType || (item.isPrime ? "prime" : "normal");
  return partType === mode;
}

// sort modes that read a single numeric field directly
const DIRECT_METRIC_FIELDS = [
  "platinum",
  "ducats",
  "amount",
  "count",
  "time",
  "disposition",
  "rerolls",
] as const;

function toMetric(item: FilterableItem, sortBy: SharedFiltersState["sortBy"]): number | null {
  if ((DIRECT_METRIC_FIELDS as readonly string[]).includes(sortBy)) {
    const v = item[sortBy as (typeof DIRECT_METRIC_FIELDS)[number]];
    return typeof v === "number" ? v : null;
  }
  if (sortBy === "grade") {
    if (typeof item.gradeRank === "number") return item.gradeRank;
    if (typeof item.grade === "number") return item.grade;
    if (typeof item.grade === "string") return GRADE_ORDER[item.grade.toUpperCase()] ?? null;
    return null;
  }
  if (sortBy === "attr_grade") {
    return typeof item.attrGradeRank === "number" ? item.attrGradeRank : null;
  }
  if (sortBy === "owned") {
    if (typeof item.owned === "boolean") return item.owned ? 1 : 0;
    if (typeof item.currentlyOwned === "boolean") return item.currentlyOwned ? 1 : 0;
    if (typeof item.amount === "number") return item.amount > 0 ? 1 : 0;
    return null;
  }
  if (sortBy === "ducatonator") {
    if (typeof item.ducatonator === "number") return item.ducatonator;
    if (typeof item.ducats === "number" && typeof item.platinum === "number" && item.platinum > 0) {
      return item.ducats / item.platinum;
    }
    return null;
  }
  if (sortBy === "complete_sets") {
    if (typeof item.completeSets === "number") return item.completeSets;
    if (typeof item.completeSets === "boolean") return item.completeSets ? 1 : 0;
    return null;
  }
  if (sortBy === "missing_parts") {
    return typeof item.missingParts === "number" ? item.missingParts : null;
  }
  if (sortBy === "parts_owned") {
    return typeof item.partsOwned === "number" ? item.partsOwned : null;
  }
  if (sortBy === "mastery_xp") {
    return typeof item.masteryXpRemaining === "number" ? item.masteryXpRemaining : null;
  }
  return null;
}

function compareNullableNumber(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a === b) return 0;
  return direction * (a - b);
}

export function matchesSharedFilters(item: FilterableItem, filters: SharedFiltersState): boolean {
  if (!matchesSearch(item, filters.search)) return false;

  if (filters.primeMode === "prime" && item.isPrime !== true) return false;
  if (filters.primeMode === "non_prime" && item.isPrime !== false) return false;

  if (filters.masteredMode === "mastered" && !isMastered(item)) return false;
  if (filters.masteredMode === "not_mastered" && isMastered(item)) return false;

  if (!matchesYesNo(filters.orderPlaced, item.orderPlaced)) return false;
  // Strict tri-state: rows with no masterable owner drop out while active.
  if (filters.mastered !== "all" && item.parentMastered !== (filters.mastered === "yes")) {
    return false;
  }
  if (filters.spares !== "all" && item.spare !== (filters.spares === "yes")) return false;
  if (!matchesYesNo(filters.vaulted, item.vaulted)) return false;
  if (!matchesPartType(item, filters.partType)) return false;
  if (!matchesYesNo(filters.favorite, item.favorite)) return false;
  if (!matchesYesNo(filters.equipped, item.equipped)) return false;
  if (!matchesYesNo(filters.leveledUp, item.leveledUp)) return false;
  // "Not ready" removes exactly the rows you could act on - a finished build to
  // claim and a blueprint whose parts are all owned - and leaves the rest.
  if (filters.foundryState === "claimable" && item.foundryState !== "claimable") return false;
  if (filters.foundryState === "buildable" && item.foundryState !== "buildable") return false;
  // A whole set: the parent blueprint, not its parts. "buildable" already counts
  // a parent whose missing parts are still craftable from owned blueprints, or
  // warframes could never appear (their parts must be built first).
  if (
    filters.foundryState === "buildable_sets" &&
    (item.foundryState !== "buildable" || item.looseComponent === true)
  ) {
    return false;
  }
  if (
    filters.foundryState === "not_ready" &&
    (item.foundryState === "claimable" || item.foundryState === "buildable")
  ) {
    return false;
  }
  // Strict tri-state: items without a subsumed flag (primes, non-frames) drop
  // out whenever the filter is active - they can never be subsumed.
  if (filters.subsumed !== "all" && item.subsumed !== (filters.subsumed === "yes")) return false;

  if (
    filters.minimumPlatinum > 0 &&
    (typeof item.platinum !== "number" || item.platinum < filters.minimumPlatinum)
  ) {
    return false;
  }

  const filterAmount = typeof item.combinedAmount === "number" ? item.combinedAmount : item.amount;
  if (
    filters.minimumAmount > 0 &&
    (typeof filterAmount !== "number" || filterAmount < filters.minimumAmount)
  ) {
    return false;
  }

  return true;
}

// localeCompare spins up a fresh collator per call, which dominates
// Everything-tab sorts; one shared collator is roughly 10x cheaper.
const NAME_COLLATOR = new Intl.Collator();

export function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b);
}

export function compareSharedFilterSort<T extends FilterableItem>(
  a: T,
  b: T,
  filters: SharedFiltersState,
): number {
  const direction = filters.sortDirection === "asc" ? 1 : -1;

  if (filters.sortBy === "name") {
    return direction * compareNames(a.name, b.name);
  }

  const aMetric = toMetric(a, filters.sortBy);
  const bMetric = toMetric(b, filters.sortBy);
  const numeric = compareNullableNumber(aMetric, bMetric, direction);
  if (numeric !== 0) return numeric;
  return compareNames(a.name, b.name);
}

export function applySharedFiltersAndSort<T extends FilterableItem>(
  items: T[],
  filters: SharedFiltersState,
): T[] {
  return items
    .filter((item) => matchesSharedFilters(item, filters))
    .sort((a, b) => compareSharedFilterSort(a, b, filters));
}

/** Every control the shared filter bar can render, in shipped bar order. This is
    the default order a stored one is merged over. */
export const FILTER_CONTROL_IDS: readonly FilterControlId[] = [
  "search",
  "prime",
  "mastery",
  "foundryState",
  "vaulted",
  "subsumed",
  "sort",
  "orderPlaced",
  "mastered",
  "spares",
  "vaultedChips",
  "partType",
  "favorite",
  "minPlatinum",
  "minAmount",
  "equipped",
  "leveledUp",
];

// The bar keeps its two rows: basic controls always render before advanced ones,
// so a stored order only reorders within a group.
const BASIC_FILTER_CONTROLS: readonly FilterControlId[] = [
  "search",
  "prime",
  "mastery",
  "foundryState",
  "vaulted",
  "subsumed",
  "sort",
];

export function isBasicFilterControl(id: FilterControlId): boolean {
  return BASIC_FILTER_CONTROLS.includes(id);
}

// `vaulted` is the basic select, `vaultedChips` the advanced tri-state. Both write
// filters.vaulted, and no scope offers both, so the two ids never collide.
export const FILTER_CONTROL_FIELDS: Record<FilterControlId, readonly (keyof SharedFiltersState)[]> =
  {
    search: ["search"],
    prime: ["primeMode"],
    mastery: ["masteredMode"],
    foundryState: ["foundryState"],
    vaulted: ["vaulted"],
    subsumed: ["subsumed"],
    sort: ["sortBy", "sortDirection"],
    orderPlaced: ["orderPlaced"],
    mastered: ["mastered"],
    spares: ["spares"],
    vaultedChips: ["vaulted"],
    partType: ["partType"],
    favorite: ["favorite"],
    minPlatinum: ["minimumPlatinum"],
    minAmount: ["minimumAmount"],
    equipped: ["equipped"],
    leveledUp: ["leveledUp"],
  };

export const FILTER_CONTROL_LABEL_KEYS: Record<FilterControlId, MessageKey> = {
  search: "filters.searchLabel",
  prime: "common.prime",
  mastery: "common.mastery",
  foundryState: "filters.claimLabel",
  vaulted: "common.vaulted",
  subsumed: "common.subsumed",
  sort: "common.sort",
  orderPlaced: "filters.orderPlaced",
  mastered: "common.mastered",
  spares: "filters.spares",
  vaultedChips: "common.vaulted",
  partType: "filters.partTypeTitle",
  favorite: "filters.favoriteTitle",
  minPlatinum: "filters.minPlatinumTitle",
  minAmount: "filters.amount",
  equipped: "common.equippedModsOnly",
  leveledUp: "filters.leveledUpLabel",
};

/** What each scope's views actually let the bar render, mirroring the props they
    pass. Customization never widens this: an id absent here cannot be unhidden. */
export const FILTER_CONTROL_SUPPORT: Record<FilterScope, readonly FilterControlId[]> = {
  // Two bars, one scope: the header renders search/sort, the panel the advanced row.
  inventory: [
    "search",
    "sort",
    "orderPlaced",
    "mastered",
    "spares",
    "vaultedChips",
    "partType",
    "favorite",
    "minPlatinum",
    "minAmount",
    "equipped",
    "leveledUp",
  ],
  mastery: ["search", "prime", "mastery", "foundryState", "vaulted", "subsumed", "sort"],
  market: ["search", "sort"],
  foundry: ["search", "prime", "mastery", "foundryState", "vaulted", "subsumed", "sort"],
  rivens: ["search", "sort"],
};

export const FILTER_SCOPES = Object.keys(FILTER_CONTROL_SUPPORT) as readonly FilterScope[];

export function defaultFilterControlOrder(scope: FilterScope): FilterControlId[] {
  const supported = FILTER_CONTROL_SUPPORT[scope];
  return FILTER_CONTROL_IDS.filter((id) => supported.includes(id));
}
