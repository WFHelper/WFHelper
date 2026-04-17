import type { SharedFiltersState } from "../types/filters.js";
import type { MasteryStatus, PartType } from "../types/inventory.js";

export interface FilterableItem {
  name: string;
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
  ducatonator?: number | null;
  completeSets?: number | boolean | null;
  orderPlaced?: boolean;
  partType?: PartType;
  favorite?: boolean;
  equipped?: boolean;
  leveledUp?: boolean;
}

function isMastered(item: FilterableItem): boolean {
  if (item.status) return item.status === "mastered";
  if (typeof item.rank === "number" && typeof item.maxRank === "number") {
    return item.maxRank > 0 && item.rank >= item.maxRank;
  }
  return false;
}

function matchesSearch(item: FilterableItem, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;

  const fields: string[] = [
    item.name,
    item.category || "",
    item.categoryLabel || "",
    item.internalName || "",
  ];

  if (Array.isArray(item.keywords)) {
    fields.push(...item.keywords);
  }

  return fields.some((field) => field.toLowerCase().includes(query));
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

function toMetric(item: FilterableItem, sortBy: SharedFiltersState["sortBy"]): number | null {
  if (sortBy === "platinum") {
    return typeof item.platinum === "number" ? item.platinum : null;
  }
  if (sortBy === "ducats") {
    return typeof item.ducats === "number" ? item.ducats : null;
  }
  if (sortBy === "amount") {
    return typeof item.amount === "number" ? item.amount : null;
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
  if (!matchesPartType(item, filters.partType)) return false;
  if (!matchesYesNo(filters.favorite, item.favorite)) return false;
  if (
    !matchesYesNo(
      filters.setComplete,
      typeof item.completeSets === "number" ? item.completeSets > 0 : Boolean(item.completeSets),
    )
  ) {
    return false;
  }
  if (!matchesYesNo(filters.equipped, item.equipped)) return false;
  if (!matchesYesNo(filters.leveledUp, item.leveledUp)) return false;

  if (
    filters.minimumPlatinum > 0 &&
    (typeof item.platinum !== "number" || item.platinum < filters.minimumPlatinum)
  ) {
    return false;
  }

  return true;
}

export function applySharedFiltersAndSort<T extends FilterableItem>(
  items: T[],
  filters: SharedFiltersState,
): T[] {
  const direction = filters.sortDirection === "asc" ? 1 : -1;

  return items
    .filter((item) => matchesSharedFilters(item, filters))
    .sort((a, b) => {
      if (filters.sortBy === "name") {
        return direction * a.name.localeCompare(b.name);
      }

      const aMetric = toMetric(a, filters.sortBy);
      const bMetric = toMetric(b, filters.sortBy);
      const numeric = compareNullableNumber(aMetric, bMetric, direction);
      if (numeric !== 0) return numeric;
      return a.name.localeCompare(b.name);
    });
}
