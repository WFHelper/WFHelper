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
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    setComplete: "all",
    equipped: "all",
    leveledUp: "all",
  };
}

function createDefaultFiltersByScope(): Record<FilterScope, SharedFiltersState> {
  return {
    inventory: createDefaultSharedFiltersState(),
    mastery: createDefaultSharedFiltersState(),
    market: createDefaultSharedFiltersState(),
  };
}

export const sharedFiltersByScope = writable<Record<FilterScope, SharedFiltersState>>(
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

export function resetSharedFilters(scope: FilterScope): void {
  sharedFiltersByScope.update((current) => ({
    ...current,
    [scope]: createDefaultSharedFiltersState(),
  }));
}
