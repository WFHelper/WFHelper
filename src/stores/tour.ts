import { writable } from "svelte/store";

import { readStorage, writeStorage } from "../lib/persistence.js";

const TOUR_DONE_KEY = "feature-tour-done";

export const tourActive = writable(false);

export function startTour(): void {
  tourActive.set(true);
}

export function endTour(): void {
  writeStorage(TOUR_DONE_KEY, "1");
  tourActive.set(false);
}

/** First-run only: setup completion starts the tour once. */
export function shouldAutoStartTour(): boolean {
  return readStorage(TOUR_DONE_KEY) !== "1";
}
