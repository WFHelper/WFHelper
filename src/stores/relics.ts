import { writable } from "svelte/store";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

export const relicDb = writable<RelicDatabase | null>(null);
export const relicTierFilter = writable<string>("all");
export const relicSearch = writable<string>("");
export const relicSortMode = writable<"tier" | "name" | "ev" | "ducat" | "ducatonator">("tier");
export const relicSortDirection = writable<"asc" | "desc">("asc");
export const relicQualityMode = writable<
  "owned" | "intact" | "exceptional" | "flawless" | "radiant"
>("owned");
export const relicSquadSize = writable<number>(1);
export const relicOwnedCounts = writable<OwnedCounts>({});
export const relicEvRevision = writable<number>(0);
