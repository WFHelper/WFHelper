import { persistedString, readStorage } from "../lib/persistence.js";
import { RELIC_VIEW_PREFERENCES, type RelicViewPreference } from "../lib/relic/relicView.js";

const STORAGE_KEY = "wf_relic_view";

export const relicViewPreference = persistedString<RelicViewPreference>(
  STORAGE_KEY,
  RELIC_VIEW_PREFERENCES,
  "auto",
);

// Popout windows share this storage but hold their own copy of the store.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const raw = readStorage(STORAGE_KEY);
    relicViewPreference.set(RELIC_VIEW_PREFERENCES.find((value) => value === raw) ?? "auto");
  });
}
