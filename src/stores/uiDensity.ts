import { persistedString } from "../lib/persistence.js";

/**
 * UI density preference for list-style views (currently just Market orders).
 *   - "compact": grid of small cards (default)
 *   - "row":     single-line rows (the original layout)
 */
export type UiDensity = "compact" | "row";

const STORAGE_KEY = "ui.marketDensity";
export const marketDensity = persistedString<UiDensity>(STORAGE_KEY, ["compact", "row"], "compact");
