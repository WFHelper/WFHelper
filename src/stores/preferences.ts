import { persistedBoolean } from "../lib/persistence.js";

export const hideFounderMasteryItems = persistedBoolean(
  "wf_hide_founder_mastery_items",
  false,
);
