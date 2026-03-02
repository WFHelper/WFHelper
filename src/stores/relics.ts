import { writable } from "svelte/store";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

export const relicDb = writable<RelicDatabase | null>(null);
export const relicTierFilter = writable<string>("all");
export const relicSearch = writable<string>("");
export const relicSortMode = writable<"tier" | "ev_desc" | "ev_asc">("tier");
export const relicQualityMode = writable<
  "best" | "intact" | "exceptional" | "flawless" | "radiant"
>("best");
export const relicSquadSize = writable<number>(1);
export const relicOwnedCounts = writable<OwnedCounts>({});
export const relicEvRevision = writable<number>(0);
