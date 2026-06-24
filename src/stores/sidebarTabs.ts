import { derived, type Readable, type Writable } from "svelte/store";

import { persistedBoolean } from "../lib/persistence.js";
import type { MessageKey } from "../lib/i18n.js";

// Tabs the user can hide. Inventory and Settings are deliberately absent: one is
// the default landing view, the other is how you get the rest back.
export const TOGGLEABLE_TABS: ReadonlyArray<{ view: string; labelKey: MessageKey }> = [
  { view: "foundry", labelKey: "nav.foundry" },
  { view: "mastery", labelKey: "nav.mastery" },
  { view: "stats", labelKey: "nav.stats" },
  { view: "world", labelKey: "nav.world" },
  { view: "market", labelKey: "nav.market" },
  { view: "relics", labelKey: "nav.relics" },
  { view: "wiki", labelKey: "nav.wiki" },
  { view: "rivens", labelKey: "nav.rivens" },
];

export const tabVisibility: Record<string, Writable<boolean>> = Object.fromEntries(
  TOGGLEABLE_TABS.map((t) => [t.view, persistedBoolean(`wf_tab_visible_${t.view}`, true)]),
);

/** Views currently switched off, for the sidebar to filter against. */
export const hiddenTabs: Readable<Set<string>> = derived(
  TOGGLEABLE_TABS.map((t) => tabVisibility[t.view]),
  (visible) => {
    const hidden = new Set<string>();
    TOGGLEABLE_TABS.forEach((t, i) => {
      if (!visible[i]) hidden.add(t.view);
    });
    return hidden;
  },
);
