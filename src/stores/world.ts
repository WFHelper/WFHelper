import { writable } from "svelte/store";
import type { WorldState } from "../types/world.js";

function readInitialFissureMode(): "normal" | "steel" {
  if (typeof localStorage === "undefined") return "normal";
  return localStorage.getItem("wf_fissure_mode") === "steel"
    ? "steel"
    : "normal";
}

export const worldData = writable<WorldState | null>(null);
export const worldLastFetch = writable<number>(0);
export const worldLoading = writable<boolean>(false);
export const worldFissureMode = writable<"normal" | "steel">(
  readInitialFissureMode(),
);

worldFissureMode.subscribe((value) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("wf_fissure_mode", value);
  }
});
