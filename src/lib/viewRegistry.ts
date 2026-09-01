import type { Component } from "svelte";

import type { MessageKey } from "./i18n.js";
import type { ToggleableView, ViewName } from "../types/views.js";

/** Every view that owns a sidebar row; setup is wizard-only and has none. */
export type SidebarViewName = Exclude<ViewName, "setup">;

/** Views loaded on first visit. Everything else is in the initial bundle. */
export type LazyViewName = Extract<
  ViewName,
  "world" | "market" | "analytics" | "relics" | "wiki" | "arbi"
>;

type LazyViewComponent = Component<Record<string, never>>;

export const LAZY_VIEW_LOADERS: Record<
  LazyViewName,
  () => Promise<{ default: LazyViewComponent }>
> = {
  world: () => import("../views/WorldView.svelte"),
  market: () => import("../views/MarketView.svelte"),
  analytics: () => import("../views/MarketAnalysisView.svelte"),
  relics: () => import("../views/RelicsView.svelte"),
  wiki: () => import("../views/WikiView.svelte"),
  arbi: () => import("../views/ArbiAnalyzeView.svelte"),
};

export function isLazyView(view: ViewName): view is LazyViewName {
  return view in LAZY_VIEW_LOADERS;
}

export const VIEW_LABEL_KEYS: Record<ViewName, MessageKey> = {
  setup: "nav.setup",
  inventory: "common.inventory",
  foundry: "common.foundry",
  mastery: "common.mastery",
  stats: "common.stats",
  world: "common.world",
  market: "common.market",
  analytics: "common.analytics",
  relics: "common.relics",
  wiki: "common.wiki",
  rivens: "common.rivens",
  arbi: "common.arbitrations",
  settings: "common.settings",
};

// The one sidebar registry: declaration order is the default row order (Object.keys
// keeps string-key insertion order) and the value says whether the user may hide the
// row. Being a Record over the union, a new ViewName fails to compile until listed.
const SIDEBAR_VIEW_HIDEABLE: Record<SidebarViewName, boolean> = {
  inventory: false,
  foundry: true,
  mastery: true,
  stats: true,
  world: true,
  market: true,
  analytics: true,
  relics: true,
  wiki: true,
  rivens: true,
  arbi: true,
  settings: false,
};

/** Default sidebar order. A persisted order is merged over this, never replaces it. */
export const SIDEBAR_VIEW_ORDER = Object.keys(SIDEBAR_VIEW_HIDEABLE) as readonly SidebarViewName[];

export function isToggleableView(view: SidebarViewName): view is ToggleableView {
  return SIDEBAR_VIEW_HIDEABLE[view];
}

/** Hideable views in default order; inventory and settings are deliberately absent:
    one is the landing view, the other is how you get the rest back. */
export const TOGGLEABLE_VIEWS: readonly ToggleableView[] =
  SIDEBAR_VIEW_ORDER.filter(isToggleableView);

/** Merge a stored order over a default one. Unknown and repeated ids are dropped,
    and an id the stored order never held is re-inserted after its nearest surviving
    default predecessor. Generic so a test can prove the rule against a default list
    the shipped registry does not have yet. */
export function mergeOrderOverDefaults<T extends string>(
  defaults: readonly T[],
  stored: readonly unknown[] | null | undefined,
): T[] {
  const known = new Set<string>(defaults);
  const merged: T[] = [];
  const placed = new Set<T>();

  for (const id of stored ?? []) {
    if (typeof id !== "string" || !known.has(id)) continue;
    const view = id as T;
    if (placed.has(view)) continue;
    placed.add(view);
    merged.push(view);
  }

  defaults.forEach((view, defaultIndex) => {
    if (placed.has(view)) return;
    let at = 0;
    for (let i = defaultIndex - 1; i >= 0; i--) {
      const found = merged.indexOf(defaults[i]);
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    merged.splice(at, 0, view);
    placed.add(view);
  });

  return merged;
}

/** A view registered in a later build needs no stored-order migration: it
    surfaces at its registry slot the first time the merge runs. */
export function mergeSidebarOrder(
  stored: readonly unknown[] | null | undefined,
): SidebarViewName[] {
  return mergeOrderOverDefaults(SIDEBAR_VIEW_ORDER, stored);
}
