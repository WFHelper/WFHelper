import { writable } from "svelte/store";
import { readStorage } from "../lib/persistence.js";

// v2: the 0.2.0 overhaul (new wizard, themes, overlay placement) runs the
// wizard once more for users upgrading from older builds. Bump only when a
// future overhaul should do the same again.
export const SETUP_COMPLETED_KEY = "setup-completed-v2";

function getInitialView(): string {
  return readStorage(SETUP_COMPLETED_KEY) === "1" ? "inventory" : "setup";
}

export const currentView = writable<string>(getInitialView());
export const statusText = writable<string>("No inventory loaded");
