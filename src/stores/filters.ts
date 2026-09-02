import { derived, writable, type Readable } from "svelte/store";
import type { FilterScope, SharedFiltersState } from "../types/filters.js";

function createDefaultSharedFiltersState(): SharedFiltersState {
  return {
    search: "",
    primeMode: "all",
    masteredMode: "all",
    sortBy: "name",
    sortDirection: "asc",
    orderPlaced: "all",
    mastered: "all",
    spares: "all",
    vaulted: "all",
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    minimumAmount: 0,
    equipped: "all",
    leveledUp: "all",
    subsumed: "all",
    foundryState: "all",
  };
}

function createDefaultFiltersByScope(): Record<FilterScope, SharedFiltersState> {
  return {
    inventory: createDefaultSharedFiltersState(),
    mastery: createDefaultSharedFiltersState(),
    market: createDefaultSharedFiltersState(),
    foundry: {
      ...createDefaultSharedFiltersState(),
      sortBy: "count",
      sortDirection: "desc",
    },
    rivens: createDefaultSharedFiltersState(),
  };
}

const sharedFiltersByScope = writable<Record<FilterScope, SharedFiltersState>>(
  createDefaultFiltersByScope(),
);

export function sharedFilters(scope: FilterScope): Readable<SharedFiltersState> {
  return derived(sharedFiltersByScope, ($filters) => $filters[scope]);
}

export function updateSharedFilters(scope: FilterScope, patch: Partial<SharedFiltersState>): void {
  sharedFiltersByScope.update((current) => ({
    ...current,
    [scope]: {
      ...current[scope],
      ...patch,
    },
  }));
}

/** Put single fields back to the scope default. Hiding a filter bar control calls
    this so a control the user can no longer see cannot keep filtering the list. */
export function resetSharedFilterFields(
  scope: FilterScope,
  fields: readonly (keyof SharedFiltersState)[],
): void {
  if (fields.length === 0) return;
  const defaults = createDefaultFiltersByScope()[scope];
  const patch: Partial<SharedFiltersState> = {};
  for (const field of fields) Object.assign(patch, { [field]: defaults[field] });
  updateSharedFilters(scope, patch);
}

export function resetSharedFilters(scope: FilterScope): void {
  sharedFiltersByScope.update((current) => ({
    ...current,
    // Per-scope defaults: foundry resets to count/desc, not the generic name/asc.
    [scope]: createDefaultFiltersByScope()[scope],
  }));
}
