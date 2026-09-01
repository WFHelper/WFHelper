import { describe, expect, it } from "vitest";

import {
  SIDEBAR_VIEW_ORDER,
  TOGGLEABLE_VIEWS,
  isToggleableView,
  mergeOrderOverDefaults,
  mergeSidebarOrder,
} from "../../../src/lib/viewRegistry.js";

describe("sidebar registry", () => {
  it("keeps inventory first and settings last by default", () => {
    expect(SIDEBAR_VIEW_ORDER[0]).toBe("inventory");
    expect(SIDEBAR_VIEW_ORDER[SIDEBAR_VIEW_ORDER.length - 1]).toBe("settings");
  });

  it("pins inventory and settings visible", () => {
    expect(isToggleableView("inventory")).toBe(false);
    expect(isToggleableView("settings")).toBe(false);
    expect(TOGGLEABLE_VIEWS).not.toContain("inventory");
    expect(TOGGLEABLE_VIEWS).not.toContain("settings");
    expect(TOGGLEABLE_VIEWS).toContain("market");
  });

  it("lists the toggleable views in default order", () => {
    const defaults = SIDEBAR_VIEW_ORDER.filter(isToggleableView);
    expect([...TOGGLEABLE_VIEWS]).toEqual(defaults);
  });
});

describe("mergeSidebarOrder", () => {
  it("falls back to the registry default when nothing is stored", () => {
    expect(mergeSidebarOrder(null)).toEqual([...SIDEBAR_VIEW_ORDER]);
    expect(mergeSidebarOrder(undefined)).toEqual([...SIDEBAR_VIEW_ORDER]);
    expect(mergeSidebarOrder([])).toEqual([...SIDEBAR_VIEW_ORDER]);
  });

  it("honours a stored order and still returns every registered view", () => {
    const merged = mergeSidebarOrder(["settings", "market", "inventory"]);
    // Only the relative order of the stored ids is promised; the views the
    // stored order omitted fill in around them.
    expect(merged.filter((v) => ["settings", "market", "inventory"].includes(v))).toEqual([
      "settings",
      "market",
      "inventory",
    ]);
    expect([...merged].sort()).toEqual([...SIDEBAR_VIEW_ORDER].sort());
  });

  it("round-trips a full user reorder unchanged", () => {
    const reversed = [...SIDEBAR_VIEW_ORDER].reverse();
    expect(mergeSidebarOrder(reversed)).toEqual(reversed);
  });

  it("drops ids from a newer build and non-string junk", () => {
    const merged = mergeSidebarOrder(["market", "workshop2", 7, null, { view: "wiki" }, "market"]);
    expect(merged).not.toContain("workshop2");
    expect(merged.filter((v) => v === "market")).toHaveLength(1);
    expect(merged).toHaveLength(SIDEBAR_VIEW_ORDER.length);
  });

  it("re-adds a view the stored order never held, at its default slot", () => {
    // A downgrade-then-upgrade order: everything except stats, in default order.
    const stored = SIDEBAR_VIEW_ORDER.filter((view) => view !== "stats");
    const merged = mergeSidebarOrder(stored);
    expect(merged).toEqual([...SIDEBAR_VIEW_ORDER]);
  });
});

describe("mergeOrderOverDefaults", () => {
  // Stands in for the real registry so a view id that does not exist yet can be
  // registered here and asserted on.
  const defaults = ["inventory", "analytics", "market", "settings"] as const;

  it("surfaces a newly registered id with no stored-order migration", () => {
    // Stored by a build that never knew "analytics", and reordered by the user.
    const stored = ["settings", "market", "inventory"];
    expect(mergeOrderOverDefaults(defaults, stored)).toEqual([
      "settings",
      "market",
      "inventory",
      "analytics",
    ]);
  });

  it("places a new id after its surviving default predecessor", () => {
    expect(mergeOrderOverDefaults(defaults, ["inventory", "settings", "market"])).toEqual([
      "inventory",
      "analytics",
      "settings",
      "market",
    ]);
  });

  it("puts a new id with no surviving predecessor at the front", () => {
    const leading = ["analytics", "inventory", "market"] as const;
    expect(mergeOrderOverDefaults(leading, ["market", "inventory"])).toEqual([
      "analytics",
      "market",
      "inventory",
    ]);
  });

  it("keeps consecutive new ids in their default order", () => {
    const grown = ["inventory", "analytics", "reports", "settings"] as const;
    expect(mergeOrderOverDefaults(grown, ["settings", "inventory"])).toEqual([
      "settings",
      "inventory",
      "analytics",
      "reports",
    ]);
  });

  it("is idempotent", () => {
    const once = mergeOrderOverDefaults(defaults, ["market", "settings"]);
    expect(mergeOrderOverDefaults(defaults, once)).toEqual(once);
  });
});
