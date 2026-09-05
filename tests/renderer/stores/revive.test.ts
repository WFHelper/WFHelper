import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { defaultFilterControlOrder } from "../../../src/lib/filters.js";
import type { FilterScope } from "../../../src/types/filters.js";

// Every store reads localStorage once at import, so a case seeds storage and
// then takes a fresh module registry.
const MALFORMED = "{not json";
const BLANK = "   ";

function seed(key: string, stored?: string): void {
  const mem = new Map<string, string>();
  if (stored !== undefined) mem.set(key, stored);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../../src/lib/ipc.js");
  vi.doUnmock("../../../src/stores/data.js");
});

describe("dashboard revive", () => {
  const KEY = "wf_dashboard_v1";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/dashboard.js");
    return get(mod.dashboardLayout);
  }

  it("returns registry defaults for a missing, blank or malformed file", async () => {
    const missing = await load();
    expect(missing.version).toBe(1);
    expect(missing.widgets.length).toBeGreaterThan(0);
    expect(missing.widgets.every((widget) => !widget.hidden)).toBe(true);
    expect(await load(BLANK)).toEqual(missing);
    expect(await load(MALFORMED)).toEqual(missing);
  });

  it("keeps a stored widget flag", async () => {
    const layout = await load(
      JSON.stringify({ version: 1, widgets: [{ id: "widget.cycles", hidden: true }] }),
    );
    expect(layout.widgets.find((widget) => widget.id === "widget.cycles")?.hidden).toBe(true);
    expect(layout.widgets.filter((widget) => widget.hidden)).toHaveLength(1);
  });
});

describe("layout revive", () => {
  const KEY = "wf_layout_v1";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/layout.js");
    return get(mod.layoutState);
  }

  it("starts empty for a missing, blank or malformed file", async () => {
    const empty = { version: 1, views: {} };
    expect(await load()).toEqual(empty);
    expect(await load(BLANK)).toEqual(empty);
    expect(await load(MALFORMED)).toEqual(empty);
  });

  it("keeps a stored view", async () => {
    const state = await load(
      JSON.stringify({
        version: 1,
        views: { world: { wide: { sections: [{ id: "world.cycles", span: 2 }] } } },
      }),
    );
    expect(state).toEqual({
      version: 1,
      views: {
        world: {
          wide: {
            version: 1,
            sections: [{ id: "world.cycles", span: 2, hidden: false, collapsed: false }],
          },
        },
      },
    });
  });
});

describe("workspaces revive", () => {
  const KEY = "wf_workspaces_v1";

  async function load(stored?: string) {
    seed(KEY, stored);
    vi.doMock("../../../src/lib/ipc.js", () => ({
      invoke: async () => ({ ok: true }),
      on: () => () => undefined,
    }));
    const mod = await import("../../../src/stores/workspaces.js");
    return get(mod.workspaces);
  }

  it("starts empty for a missing, blank or malformed file", async () => {
    const empty = { version: 1, workspaces: [], restoreOnLaunch: null };
    expect(await load()).toEqual(empty);
    expect(await load(BLANK)).toEqual(empty);
    expect(await load(MALFORMED)).toEqual(empty);
  });

  it("keeps a stored workspace", async () => {
    const file = await load(
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: "ws-1",
            name: "ws one",
            sidebar: { order: ["inventory", "settings"], hidden: ["world"], width: 240 },
            layout: { version: 1, views: {} },
            popouts: [],
          },
        ],
        restoreOnLaunch: "ws-1",
      }),
    );
    expect(file.workspaces).toHaveLength(1);
    expect(file.workspaces[0]?.id).toBe("ws-1");
    expect(file.restoreOnLaunch).toBe("ws-1");
  });
});

describe("custom CSS revive", () => {
  const KEY = "wf_custom_css_v1";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/customCss.js");
    return get(mod.customCss);
  }

  it("is empty for a missing, blank or malformed file", async () => {
    const empty = { enabled: false, css: "", updatedAt: 0 };
    expect(await load()).toEqual(empty);
    expect(await load(BLANK)).toEqual(empty);
    expect(await load(MALFORMED)).toEqual(empty);
  });

  it("keeps a stored sheet", async () => {
    expect(
      await load(JSON.stringify({ enabled: true, css: "body{}", updatedAt: 5, extra: 1 })),
    ).toEqual({ enabled: true, css: "body{}", updatedAt: 5 });
  });
});

describe("inventory safety revive", () => {
  const KEY = "inventory.safety";
  const MOD_KEY = "/Lotus/Upgrades/Mods/Serration";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/inventorySafety.js");
    return get(mod.inventorySafety);
  }

  it("falls back to the defaults for a missing, blank or malformed file", async () => {
    const defaults = { spareDefault: 0, spares: {}, locks: [], setKeep: [] };
    expect(await load()).toEqual(defaults);
    expect(await load(BLANK)).toEqual(defaults);
    expect(await load(MALFORMED)).toEqual(defaults);
  });

  it("keeps stored locks and spares", async () => {
    expect(
      await load(
        JSON.stringify({ spareDefault: 3, spares: { [MOD_KEY]: 2 }, locks: [MOD_KEY, 7] }),
      ),
    ).toEqual({ spareDefault: 3, spares: { [MOD_KEY]: 2 }, locks: [MOD_KEY], setKeep: [] });
  });
});

describe("filter layout revive", () => {
  const KEY = "wf_filter_layout_v1";
  const SCOPE: FilterScope = "inventory";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/filterLayout.js");
    return get(mod.filterLayout(SCOPE));
  }

  it("uses the scope default for a missing, blank or malformed file", async () => {
    const defaults = { order: defaultFilterControlOrder(SCOPE), hidden: [] };
    expect(await load()).toEqual(defaults);
    expect(await load(BLANK)).toEqual(defaults);
    expect(await load(MALFORMED)).toEqual(defaults);
  });

  it("keeps a stored order and hidden list", async () => {
    const order = defaultFilterControlOrder(SCOPE);
    const first = order[0];
    const moved = [order[1], order[0], ...order.slice(2)];
    const layout = await load(JSON.stringify({ [SCOPE]: { order: moved, hidden: [first] } }));
    expect(layout.order).toEqual(moved);
    expect(layout.hidden).toEqual([first]);
  });
});

describe("stats chart resources revive", () => {
  const KEY = "wf_stats_chart_resources";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/statsDisplay.js");
    return get(mod.chartResources);
  }

  it("uses the defaults for a missing, blank or malformed pref", async () => {
    const defaults = await load();
    expect(defaults.length).toBeGreaterThan(0);
    expect(await load(BLANK)).toEqual(defaults);
    expect(await load(MALFORMED)).toEqual(defaults);
    expect(await load(JSON.stringify({ plat: true }))).toEqual(defaults);
  });

  it("keeps a stored pref, including an empty one", async () => {
    expect(await load(JSON.stringify(["kuva", "plat", "nope"]))).toEqual(["plat", "kuva"]);
    expect(await load("[]")).toEqual([]);
  });
});

describe("saved selections revive", () => {
  const KEY = "wf_inventory_saved_selections";

  async function load(stored?: string) {
    seed(KEY, stored);
    vi.doMock("../../../src/stores/data.js", async () => {
      const { writable } = await import("svelte/store");
      return { parsedItems: writable([]) };
    });
    const mod = await import("../../../src/stores/inventorySelection.js");
    return get(mod.savedSelections);
  }

  it("is empty for a missing, blank or malformed file", async () => {
    expect(await load()).toEqual([]);
    expect(await load(BLANK)).toEqual([]);
    expect(await load(MALFORMED)).toEqual([]);
    expect(await load(JSON.stringify({ name: "a" }))).toEqual([]);
  });

  it("keeps a stored selection and drops non-string keys", async () => {
    expect(
      await load(
        JSON.stringify([
          { name: "kept", keys: ["a", 5], alertWhenComplete: true },
          { name: "", keys: [] },
        ]),
      ),
    ).toEqual([{ name: "kept", keys: ["a"], alertWhenComplete: true }]);
  });
});

describe("syndicate goals revive", () => {
  const KEY = "wf_syndicate_goals_v1";

  async function load(stored?: string) {
    seed(KEY, stored);
    const mod = await import("../../../src/stores/syndicateGoals.js");
    return get(mod.syndicateGoals);
  }

  it("is empty for a missing, blank or malformed file", async () => {
    expect(await load()).toEqual({});
    expect(await load(BLANK)).toEqual({});
    expect(await load(MALFORMED)).toEqual({});
    expect(await load(JSON.stringify([1, 2]))).toEqual({});
  });

  it("rounds stored ranks and drops unreadable ones", async () => {
    expect(await load(JSON.stringify({ SteelMeridian: 3.6, Broken: "nope" }))).toEqual({
      SteelMeridian: 4,
    });
  });
});
