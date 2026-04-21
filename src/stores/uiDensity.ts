import { writable } from "svelte/store";

/**
 * UI density preference for list-style views (currently just Market orders).
 *   - "compact": grid of small cards (default)
 *   - "row":     single-line rows (the original layout)
 */
export type UiDensity = "compact" | "row";

const STORAGE_KEY = "ui.marketDensity";

function loadInitial(): UiDensity {
  try {
    if (typeof localStorage === "undefined") return "compact";
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "row" ? "row" : "compact";
  } catch {
    return "compact";
  }
}

function createMarketDensityStore() {
  const { subscribe, set } = writable<UiDensity>(loadInitial());

  return {
    subscribe,
    set(value: UiDensity): void {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, value);
      } catch {
        /* best effort */
      }
      set(value);
    },
  };
}

export const marketDensity = createMarketDensityStore();
