// Single source of truth for routable view ids. The router, sidebar and
// tab-visibility map all key off this, so a typo fails to compile.
export type ViewName =
  | "setup"
  | "dashboard"
  | "inventory"
  | "foundry"
  | "mastery"
  | "stats"
  | "world"
  | "market"
  | "analytics"
  | "relics"
  | "wiki"
  | "rivens"
  | "arbi"
  | "settings";

/** Views the user can hide; inventory, setup and settings are always reachable. */
export type ToggleableView = Exclude<ViewName, "setup" | "inventory" | "settings">;
