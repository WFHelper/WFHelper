import { persistedString } from "../lib/persistence.js";

export type RivenCardSize = "full" | "compact";

/** Order in the toolbar toggle; also the allow-list the persisted value degrades to. */
export const RIVEN_CARD_SIZES: readonly RivenCardSize[] = ["full", "compact"];

const STORAGE_KEY = "wf_rivens_card_size";

export const rivenCardSize = persistedString<RivenCardSize>(STORAGE_KEY, RIVEN_CARD_SIZES, "full");
