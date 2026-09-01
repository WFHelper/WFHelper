import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { SIDEBAR_VIEW_ORDER } from "../../../src/lib/viewRegistry.js";

let store = new Map<string, string>();

// sidebarTabs reads localStorage at import time, so every case needs a fresh
// module registry on top of the seeded storage.
async function loadModule(seed: Record<string, string> = {}) {
  store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.resetModules();
  return import("../../../src/stores/sidebarTabs.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sidebarOrder", () => {
  it("starts at the registry default with empty storage", async () => {
    const { sidebarOrder } = await loadModule();
    expect(get(sidebarOrder)).toEqual([...SIDEBAR_VIEW_ORDER]);
  });

  it("restores a persisted order and merges missing views back in", async () => {
    const { sidebarOrder } = await loadModule({
      wf_sidebar_order: JSON.stringify(["market", "inventory"]),
    });
    const order = get(sidebarOrder);
    expect(order.filter((v) => v === "market" || v === "inventory")).toEqual([
      "market",
      "inventory",
    ]);
    expect([...order].sort()).toEqual([...SIDEBAR_VIEW_ORDER].sort());
  });

  it("falls back to the default on corrupt storage", async () => {
    const { sidebarOrder } = await loadModule({ wf_sidebar_order: "{not json" });
    expect(get(sidebarOrder)).toEqual([...SIDEBAR_VIEW_ORDER]);
  });

  it("ignores a stored value that is not an array", async () => {
    const { sidebarOrder } = await loadModule({ wf_sidebar_order: '"market"' });
    expect(get(sidebarOrder)).toEqual([...SIDEBAR_VIEW_ORDER]);
  });

  it("persists a move and survives a reload", async () => {
    const { moveSidebarView, sidebarOrder } = await loadModule();
    moveSidebarView(0, 2);
    const moved = get(sidebarOrder);
    expect(moved[2]).toBe("inventory");
    expect(JSON.parse(store.get("wf_sidebar_order") ?? "[]")).toEqual(moved);

    vi.resetModules();
    const reloaded = await import("../../../src/stores/sidebarTabs.js");
    expect(get(reloaded.sidebarOrder)).toEqual(moved);
  });

  it("clamps an out-of-range move instead of dropping the view", async () => {
    const { moveSidebarView, sidebarOrder } = await loadModule();
    moveSidebarView(0, 99);
    const order = get(sidebarOrder);
    expect(order[order.length - 1]).toBe("inventory");
    expect(order).toHaveLength(SIDEBAR_VIEW_ORDER.length);

    moveSidebarView(99, 0);
    expect(get(sidebarOrder)).toEqual(order);
  });

  it("resets back to the registry default", async () => {
    const { moveSidebarView, resetSidebarOrder, sidebarOrder } = await loadModule();
    moveSidebarView(0, 5);
    resetSidebarOrder();
    expect(get(sidebarOrder)).toEqual([...SIDEBAR_VIEW_ORDER]);
  });

  it("repairs a direct set that drops or repeats views", async () => {
    const { sidebarOrder } = await loadModule();
    sidebarOrder.set(["market", "market", "inventory"]);
    const order = get(sidebarOrder);
    expect(order.filter((v) => v === "market")).toHaveLength(1);
    expect(order.filter((v) => v === "market" || v === "inventory")).toEqual([
      "market",
      "inventory",
    ]);
    expect([...order].sort()).toEqual([...SIDEBAR_VIEW_ORDER].sort());
  });
});

describe("sidebarWidth", () => {
  it("defaults to the token width", async () => {
    const { sidebarWidth, SIDEBAR_WIDTH_DEFAULT } = await loadModule();
    expect(get(sidebarWidth)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("restores a persisted width", async () => {
    const { sidebarWidth } = await loadModule({ wf_sidebar_width: "224" });
    expect(get(sidebarWidth)).toBe(224);
  });

  it("clamps a persisted width outside the allowed range", async () => {
    const wide = await loadModule({ wf_sidebar_width: "9000" });
    expect(get(wide.sidebarWidth)).toBe(wide.SIDEBAR_WIDTH_MAX);

    const narrow = await loadModule({ wf_sidebar_width: "-40" });
    expect(get(narrow.sidebarWidth)).toBe(narrow.SIDEBAR_RAIL_WIDTH);
  });

  it("falls back to the default on a junk width", async () => {
    const { sidebarWidth, SIDEBAR_WIDTH_DEFAULT } = await loadModule({
      wf_sidebar_width: "wide please",
    });
    expect(get(sidebarWidth)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("honours the legacy collapsed flag once", async () => {
    const { sidebarWidth, sidebarCollapsed, SIDEBAR_RAIL_WIDTH } = await loadModule({
      "sidebar.collapsed": "1",
    });
    expect(get(sidebarWidth)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(get(sidebarCollapsed)).toBe(true);
  });

  it("lets a stored width win over the legacy flag", async () => {
    const { sidebarWidth } = await loadModule({
      "sidebar.collapsed": "1",
      wf_sidebar_width: "320",
    });
    expect(get(sidebarWidth)).toBe(320);
  });

  it("persists a width change", async () => {
    const { sidebarWidth } = await loadModule();
    sidebarWidth.set(275);
    expect(store.get("wf_sidebar_width")).toBe("275");

    vi.resetModules();
    const reloaded = await import("../../../src/stores/sidebarTabs.js");
    expect(get(reloaded.sidebarWidth)).toBe(275);
  });
});

describe("snapSidebarWidth", () => {
  it("closes to the rail below the label threshold", async () => {
    const {
      snapSidebarWidth,
      SIDEBAR_RAIL_WIDTH,
      SIDEBAR_EXPAND_MIN,
      SIDEBAR_WIDTH_MAX,
      SIDEBAR_WIDTH_DEFAULT,
    } = await loadModule();
    expect(snapSidebarWidth(SIDEBAR_EXPAND_MIN - 1)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(snapSidebarWidth(SIDEBAR_EXPAND_MIN)).toBe(SIDEBAR_EXPAND_MIN);
    expect(snapSidebarWidth(-500)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(snapSidebarWidth(5000)).toBe(SIDEBAR_WIDTH_MAX);
    expect(snapSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe("collapse toggle", () => {
  it("shuts to the rail and reopens at the previous width", async () => {
    const { sidebarWidth, sidebarCollapsed, toggleSidebarCollapsed, SIDEBAR_RAIL_WIDTH } =
      await loadModule();
    sidebarWidth.set(360);

    toggleSidebarCollapsed();
    expect(get(sidebarWidth)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(get(sidebarCollapsed)).toBe(true);

    toggleSidebarCollapsed();
    expect(get(sidebarWidth)).toBe(360);
    expect(get(sidebarCollapsed)).toBe(false);
  });

  it("reopens a sidebar that started collapsed at the default width", async () => {
    const { sidebarWidth, toggleSidebarCollapsed, SIDEBAR_WIDTH_DEFAULT } = await loadModule({
      wf_sidebar_width: "60",
    });
    toggleSidebarCollapsed();
    expect(get(sidebarWidth)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it("resets to the default width", async () => {
    const { sidebarWidth, resetSidebarWidth, SIDEBAR_WIDTH_DEFAULT } = await loadModule();
    sidebarWidth.set(200);
    resetSidebarWidth();
    expect(get(sidebarWidth)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe("nudgeSidebarWidth", () => {
  it("steps within the expanded range", async () => {
    const { sidebarWidth, nudgeSidebarWidth } = await loadModule();
    sidebarWidth.set(300);
    nudgeSidebarWidth(16);
    expect(get(sidebarWidth)).toBe(316);
    nudgeSidebarWidth(-16);
    expect(get(sidebarWidth)).toBe(300);
  });

  it("opens a collapsed rail instead of stalling at the snap boundary", async () => {
    const { sidebarWidth, nudgeSidebarWidth, SIDEBAR_RAIL_WIDTH, SIDEBAR_EXPAND_MIN } =
      await loadModule();
    sidebarWidth.set(SIDEBAR_RAIL_WIDTH);
    nudgeSidebarWidth(16);
    expect(get(sidebarWidth)).toBe(SIDEBAR_EXPAND_MIN);

    sidebarWidth.set(SIDEBAR_RAIL_WIDTH);
    nudgeSidebarWidth(-16);
    expect(get(sidebarWidth)).toBe(SIDEBAR_RAIL_WIDTH);
  });

  it("shuts the rail when a step crosses the threshold", async () => {
    const { sidebarWidth, nudgeSidebarWidth, SIDEBAR_RAIL_WIDTH, SIDEBAR_EXPAND_MIN } =
      await loadModule();
    sidebarWidth.set(SIDEBAR_EXPAND_MIN);
    nudgeSidebarWidth(-16);
    expect(get(sidebarWidth)).toBe(SIDEBAR_RAIL_WIDTH);
  });
});

describe("hiddenTabs", () => {
  it("reports a tab switched off in storage", async () => {
    const { hiddenTabs } = await loadModule({ wf_tab_visible_market: "0" });
    expect(get(hiddenTabs).has("market")).toBe(true);
    expect(get(hiddenTabs).has("relics")).toBe(false);
  });

  it("never hides the pinned views", async () => {
    const { hiddenTabs } = await loadModule({
      wf_tab_visible_inventory: "0",
      wf_tab_visible_settings: "0",
    });
    expect(get(hiddenTabs).has("inventory")).toBe(false);
    expect(get(hiddenTabs).has("settings")).toBe(false);
  });
});
