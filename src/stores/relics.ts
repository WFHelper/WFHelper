import { writable } from "svelte/store";
import { readStorage, writeStorage } from "../lib/persistence.js";
import type {
  RelicQualityMode,
  RelicSortDirection,
  RelicSortMode,
  RelicVaultedMode,
} from "../../config/shared/relicPlannerView.js";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

export type {
  RelicQualityMode,
  RelicSortMode,
  RelicVaultedMode,
} from "../../config/shared/relicPlannerView.js";

const RELIC_TAB_KEY = "wf_relics_tab";
const RELIC_TABS = new Set(["all", "Lith", "Meso", "Neo", "Axi", "Requiem"]);

function restoreRelicTab(): string {
  const raw = readStorage(RELIC_TAB_KEY);
  return raw && RELIC_TABS.has(raw) ? raw : "all";
}

export type RelicOwnershipMode = "owned" | "all";

interface RelicViewState {
  tierFilter: string;
  search: string;
  sortMode: RelicSortMode;
  sortDirection: RelicSortDirection;
  qualityMode: RelicQualityMode;
  squadSize: number;
  vaultedMode: RelicVaultedMode;
  ownershipMode: RelicOwnershipMode;
  containsNeededReward: boolean;
}

const DEFAULT_RELIC_VIEW_STATE: RelicViewState = {
  tierFilter: restoreRelicTab(),
  search: "",
  sortMode: "tier",
  sortDirection: "asc",
  qualityMode: "owned",
  squadSize: 1,
  vaultedMode: "all",
  ownershipMode: "owned",
  containsNeededReward: false,
};

export const relicDb = writable<RelicDatabase | null>(null);
export const relicViewState = writable<RelicViewState>({ ...DEFAULT_RELIC_VIEW_STATE });
export const relicOwnedCounts = writable<OwnedCounts>({});
export const relicEvRevision = writable<number>(0);

export function setRelicFilter(patch: Partial<RelicViewState>): void {
  if (patch.tierFilter && RELIC_TABS.has(patch.tierFilter)) {
    writeStorage(RELIC_TAB_KEY, patch.tierFilter);
  }
  relicViewState.update((state) => ({ ...state, ...patch }));
}
