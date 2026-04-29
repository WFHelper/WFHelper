import { writable } from "svelte/store";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

export type RelicSortMode = "tier" | "name" | "ev" | "ducat" | "ducatonator";
export type RelicQualityMode = "owned" | "intact" | "exceptional" | "flawless" | "radiant";
export type RelicVaultedMode = "all" | "vaulted" | "unvaulted";

export interface RelicViewState {
  tierFilter: string;
  search: string;
  sortMode: RelicSortMode;
  sortDirection: "asc" | "desc";
  qualityMode: RelicQualityMode;
  squadSize: number;
  vaultedMode: RelicVaultedMode;
}

export const DEFAULT_RELIC_VIEW_STATE: RelicViewState = {
  tierFilter: "all",
  search: "",
  sortMode: "tier",
  sortDirection: "asc",
  qualityMode: "owned",
  squadSize: 1,
  vaultedMode: "all",
};

export const relicDb = writable<RelicDatabase | null>(null);
export const relicViewState = writable<RelicViewState>({ ...DEFAULT_RELIC_VIEW_STATE });
export const relicOwnedCounts = writable<OwnedCounts>({});
export const relicEvRevision = writable<number>(0);

export function setRelicFilter(patch: Partial<RelicViewState>): void {
  relicViewState.update((state) => ({ ...state, ...patch }));
}

export function resetRelicFilters(): void {
  relicViewState.set({ ...DEFAULT_RELIC_VIEW_STATE });
}
