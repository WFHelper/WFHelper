import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const SAVED_KEY = "wf_inventory_saved_selections";

let store: Map<string, string>;

/** The module reads storage once at import, so every case needs a fresh copy. */
async function loadModule(stored?: string) {
  store = new Map();
  if (stored !== undefined) store.set(SAVED_KEY, stored);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.resetModules();
  return await import("../../../src/stores/inventorySelection.js");
}

beforeEach(() => {
  store = new Map();
});

afterEach(() => vi.unstubAllGlobals());

describe("selection mode", () => {
  it("keeps the picks when the mode is left and restores them on re-entry", async () => {
    const mod = await loadModule();
    mod.setSelectionMode(true);
    mod.toggleSelected("a");
    expect(get(mod.inventorySelection).has("a")).toBe(true);

    mod.toggleSelectionMode();
    expect(get(mod.inventorySelectionMode)).toBe(false);
    expect([...get(mod.inventorySelection)]).toEqual(["a"]);

    mod.toggleSelectionMode();
    expect(get(mod.inventorySelectionMode)).toBe(true);
    expect([...get(mod.inventorySelection)]).toEqual(["a"]);
  });

  it("clears only on an explicit clear", async () => {
    const mod = await loadModule();
    mod.setSelectionMode(true);
    mod.toggleSelected("a");
    mod.setSelectionMode(false);
    mod.clearSelection();
    expect(get(mod.inventorySelection).size).toBe(0);
  });
});

describe("selection edits", () => {
  it("toggles a key on and off and ignores an empty one", async () => {
    const mod = await loadModule();
    mod.toggleSelected("a");
    mod.toggleSelected("b");
    mod.toggleSelected("a");
    mod.toggleSelected("");
    expect([...get(mod.inventorySelection)]).toEqual(["b"]);
  });

  it("replaces on select-all and adds on a range extend", async () => {
    const mod = await loadModule();
    mod.selectKeys(["a", "b"], "replace");
    mod.selectKeys(["c", "d"], "add");
    expect([...get(mod.inventorySelection)].sort()).toEqual(["a", "b", "c", "d"]);

    mod.selectKeys(["z"], "replace");
    expect([...get(mod.inventorySelection)]).toEqual(["z"]);

    mod.clearSelection();
    expect(get(mod.inventorySelection).size).toBe(0);
  });

  it("hands out a fresh Set so subscribers see the change", async () => {
    const mod = await loadModule();
    const before = get(mod.inventorySelection);
    mod.toggleSelected("a");
    expect(get(mod.inventorySelection)).not.toBe(before);
  });
});

describe("saved selections", () => {
  it("persists a named selection and reloads it", async () => {
    const mod = await loadModule();
    mod.selectKeys(["a", "b"], "replace");
    mod.saveSelection("  prime spares  ");
    expect(get(mod.savedSelections)).toEqual([{ name: "prime spares", keys: ["a", "b"] }]);
    expect(JSON.parse(store.get(SAVED_KEY) ?? "[]")).toEqual([
      { name: "prime spares", keys: ["a", "b"] },
    ]);

    mod.clearSelection();
    mod.loadSavedSelection("prime spares");
    expect([...get(mod.inventorySelection)]).toEqual(["a", "b"]);
  });

  it("overwrites a re-save under the same name and skips a blank one", async () => {
    const mod = await loadModule();
    mod.selectKeys(["a"], "replace");
    mod.saveSelection("set");
    mod.selectKeys(["b"], "replace");
    mod.saveSelection("set");
    mod.saveSelection("   ");
    expect(get(mod.savedSelections)).toEqual([{ name: "set", keys: ["b"] }]);
  });

  it("deletes one entry and leaves the rest", async () => {
    const mod = await loadModule();
    mod.selectKeys(["a"], "replace");
    mod.saveSelection("one");
    mod.saveSelection("two");
    mod.deleteSavedSelection("one");
    expect(get(mod.savedSelections).map((entry) => entry.name)).toEqual(["two"]);
  });

  it("ignores a load for a name that is gone", async () => {
    const mod = await loadModule();
    mod.selectKeys(["a"], "replace");
    mod.loadSavedSelection("missing");
    expect([...get(mod.inventorySelection)]).toEqual(["a"]);
  });

  it("restores a stored list and discards malformed entries", async () => {
    const mod = await loadModule(
      JSON.stringify([{ name: "ok", keys: ["a", 3] }, { name: "" }, "junk", { keys: [] }]),
    );
    expect(get(mod.savedSelections)).toEqual([{ name: "ok", keys: ["a"] }]);
  });

  it("starts empty on corrupt storage", async () => {
    const mod = await loadModule("{not json");
    expect(get(mod.savedSelections)).toEqual([]);
  });
});
