import { writable } from "svelte/store";
import { persistedString } from "../lib/persistence.js";
import type { WorldState } from "../types/world.js";

export const worldData = writable<WorldState | null>(null);
export const worldLastFetch = writable<number>(0);
export const worldLoading = writable<boolean>(false);
export const worldFissureMode = persistedString<"normal" | "steel" | "railjack">(
  "wf_fissure_mode",
  ["normal", "steel", "railjack"],
  "normal",
);
