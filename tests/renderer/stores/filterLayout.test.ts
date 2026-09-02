import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { FILTER_CONTROL_SUPPORT, defaultFilterControlOrder } from "../../../src/lib/filters.js";
import type { FilterScope } from "../../../src/types/filters.js";

let store = new Map<string, string>();

// filterLayout reads localStorage at import time, so every case needs a fresh
// module registry on top of the seeded storage.
async function loadModules(seed: Record<string, string> = {}) {
  store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.resetModules();
  const layout = await import("../../../src/stores/filterLayout.js");
  const filters = await import("../../../src/stores/filters.js");
  return { ...layout, ...filters };
}

function stored(): Record<string, { order: string[]; hidden: string[] }> {
  return JSON.parse(store.get("wf_filter_layout_v1") ?? "{}");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filter control registry", () => {
  it("keeps every scope's supported controls in shipped bar order", () => {
    expect(defaultFilterControlOrder("market")).toEqual(["search", "sort"]);
    expect(defaultFilterControlOrder("rivens")).toEqual(["search", "sort"]);
    expect(defaultFilterControlOrder("mastery")).toEqual([
      "search",
      "prime",
      "mastery",
      "foundryState",
      "vaulted",
      "subsumed",
      "sort",
    ]);
    expect(defaultFilterControlOrder("foundry")).toEqual(defaultFilterControlOrder("mastery"));
  });

  it("gives inventory the advanced controls and no basic-only select", () => {
    const inventory = defaultFilterControlOrder("inventory");
    expect(inventory.slice(0, 2)).toEqual(["search", "sort"]);
    expect(inventory).toContain("spares");
    expect(inventory).toContain("vaultedChips");
    // The inventory bars never pass basicVariant="full", so these stay off.
    expect(inventory).not.toContain("prime");
    expect(inventory).not.toContain("vaulted");
    expect(inventory).not.toContain("foundryState");
  });

  it("never lists an advanced control outside inventory", () => {
    for (const scope of ["mastery", "market", "foundry", "rivens"] as FilterScope[]) {
      expect(FILTER_CONTROL_SUPPORT[scope]).not.toContain("spares");
      expect(FILTER_CONTROL_SUPPORT[scope]).not.toContain("minPlatinum");
    }
  });
});

describe("filterLayout defaults and merging", () => {
  it("starts at the per-scope default with empty storage", async () => {
    const { filterLayout } = await loadModules();
    expect(get(filterLayout("mastery"))).toEqual({
      order: defaultFilterControlOrder("mastery"),
      hidden: [],
    });
  });

  it("round-trips a complete stored order", async () => {
    const { filterLayout } = await loadModules({
      wf_filter_layout_v1: JSON.stringify({ market: { order: ["sort", "search"] } }),
    });
    expect(get(filterLayout("market")).order).toEqual(["sort", "search"]);
  });

  it("keeps a partial stored order and returns missing ids at their default slot", async () => {
    const { filterLayout } = await loadModules({
      wf_filter_layout_v1: JSON.stringify({ mastery: { order: ["sort", "subsumed"] } }),
    });
    const order = get(filterLayout("mastery")).order;
    expect(order.indexOf("sort")).toBeLessThan(order.indexOf("subsumed"));
    expect(order.slice(0, 2)).toEqual(["search", "prime"]);
    expect([...order].sort()).toEqual([...defaultFilterControlOrder("mastery")].sort());
  });

  it("drops ids a different build wrote", async () => {
    const { filterLayout } = await loadModules({
      wf_filter_layout_v1: JSON.stringify({
        market: { order: ["sort", "banana", "sort", "spares"], hidden: ["banana", "spares"] },
      }),
    });
    expect(get(filterLayout("market"))).toEqual({ order: ["search", "sort"], hidden: [] });
  });

  it("keeps a hidden id the scope still supports", async () => {
    const { filterLayout } = await loadModules({
      wf_filter_layout_v1: JSON.stringify({ market: { hidden: ["search", "search"] } }),
    });
    expect(get(filterLayout("market")).hidden).toEqual(["search"]);
  });

  it("falls back to defaults on corrupt or non-object storage", async () => {
    const broken = await loadModules({ wf_filter_layout_v1: "{not json" });
    expect(get(broken.filterLayout("foundry")).order).toEqual(defaultFilterControlOrder("foundry"));

    const list = await loadModules({ wf_filter_layout_v1: '["search"]' });
    expect(get(list.filterLayout("foundry")).order).toEqual(defaultFilterControlOrder("foundry"));

    const junkScope = await loadModules({ wf_filter_layout_v1: '{"foundry":"search"}' });
    expect(get(junkScope.filterLayout("foundry")).order).toEqual(
      defaultFilterControlOrder("foundry"),
    );
  });
});

describe("moveControl", () => {
  it("reorders, persists and survives a reload", async () => {
    const { filterLayout, moveControl } = await loadModules();
    moveControl("mastery", 0, 2);
    const moved = get(filterLayout("mastery")).order;
    expect(moved[2]).toBe("search");
    expect(stored()["mastery"]?.order).toEqual(moved);

    vi.resetModules();
    const reloaded = await import("../../../src/stores/filterLayout.js");
    expect(get(reloaded.filterLayout("mastery")).order).toEqual(moved);
  });

  it("clamps an out-of-range move instead of dropping a control", async () => {
    const { filterLayout, moveControl } = await loadModules();
    moveControl("mastery", 0, 99);
    const order = get(filterLayout("mastery")).order;
    expect(order[order.length - 1]).toBe("search");
    expect(order).toHaveLength(defaultFilterControlOrder("mastery").length);

    moveControl("mastery", 99, 0);
    expect(get(filterLayout("mastery")).order).toEqual(order);
  });

  it("leaves other scopes alone", async () => {
    const { filterLayout, moveControl } = await loadModules();
    moveControl("market", 0, 1);
    expect(get(filterLayout("market")).order).toEqual(["sort", "search"]);
    expect(get(filterLayout("rivens")).order).toEqual(["search", "sort"]);
  });
});

describe("setHidden", () => {
  it("resets the filter the hidden control drove", async () => {
    const { setHidden, sharedFilters, updateSharedFilters } = await loadModules();
    updateSharedFilters("inventory", { search: "loki", minimumPlatinum: 40, spares: "yes" });

    setHidden("inventory", "search", true);
    setHidden("inventory", "minPlatinum", true);
    setHidden("inventory", "spares", true);

    const state = get(sharedFilters("inventory"));
    expect(state.search).toBe("");
    expect(state.minimumPlatinum).toBe(0);
    expect(state.spares).toBe("all");
  });

  it("resets a hidden sort to the scope default, not the generic one", async () => {
    const { setHidden, sharedFilters, updateSharedFilters } = await loadModules();
    updateSharedFilters("foundry", { sortBy: "name", sortDirection: "asc" });
    setHidden("foundry", "sort", true);
    expect(get(sharedFilters("foundry"))).toMatchObject({
      sortBy: "count",
      sortDirection: "desc",
    });
  });

  it("clears the advanced vaulted chips through the same field as the select", async () => {
    const { setHidden, sharedFilters, updateSharedFilters } = await loadModules();
    updateSharedFilters("inventory", { vaulted: "no" });
    setHidden("inventory", "vaultedChips", true);
    expect(get(sharedFilters("inventory")).vaulted).toBe("all");
  });

  it("persists hidden ids and unhides without touching the value", async () => {
    const { filterLayout, setHidden, sharedFilters, updateSharedFilters } = await loadModules();
    setHidden("mastery", "subsumed", true);
    expect(stored()["mastery"]?.hidden).toEqual(["subsumed"]);

    updateSharedFilters("mastery", { subsumed: "yes" });
    setHidden("mastery", "subsumed", false);
    expect(get(filterLayout("mastery")).hidden).toEqual([]);
    expect(get(sharedFilters("mastery")).subsumed).toBe("yes");
  });

  it("ignores a control the scope does not support", async () => {
    const { filterLayout, setHidden } = await loadModules();
    setHidden("market", "spares", true);
    expect(get(filterLayout("market")).hidden).toEqual([]);
  });
});

describe("resetScope", () => {
  it("restores one scope to the default order with nothing hidden", async () => {
    const { filterLayout, moveControl, resetScope, setHidden } = await loadModules();
    moveControl("mastery", 0, 3);
    setHidden("mastery", "vaulted", true);
    resetScope("mastery");
    expect(get(filterLayout("mastery"))).toEqual({
      order: defaultFilterControlOrder("mastery"),
      hidden: [],
    });
  });
});

describe("workspace snapshots", () => {
  it("round-trips the whole state and resets controls that become hidden", async () => {
    const m = await loadModules();
    m.updateSharedFilters("mastery", { primeMode: "prime" });
    const snapshot = m.getFilterLayoutState();
    expect(Object.keys(snapshot)).toEqual(expect.arrayContaining(["mastery", "inventory"]));

    m.applyFilterLayoutState({
      mastery: { order: ["sort", "search", "prime"], hidden: ["prime"] },
    });
    const mastery = get(m.filterLayout("mastery"));
    expect(mastery.order.slice(0, 2)).toEqual(["sort", "search"]);
    expect(mastery.hidden).toEqual(["prime"]);
    // The hidden control's value went back to its default, like a manual hide.
    expect(get(m.sharedFilters("mastery")).primeMode).toBe("all");
    // A scope absent from the snapshot keeps its current layout.
    expect(get(m.filterLayout("inventory")).order).toEqual(defaultFilterControlOrder("inventory"));
    expect(stored().mastery.hidden).toEqual(["prime"]);
  });
});
