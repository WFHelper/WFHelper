// Single source of truth for routable view ids. The router, sidebar, layout and
// theme storage all key off this one list, so a typo fails to compile. Order is
// load-bearing: it is the default sidebar row order.
export const VIEW_NAMES = [
  "setup",
  "dashboard",
  "inventory",
  "foundry",
  "mastery",
  "stats",
  "world",
  "syndicates",
  "market",
  "analytics",
  "relics",
  "wiki",
  "rivens",
  "arbi",
  "settings",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/** Views the user can hide; inventory, setup and settings are always reachable. */
export type ToggleableView = Exclude<ViewName, "setup" | "inventory" | "settings">;
