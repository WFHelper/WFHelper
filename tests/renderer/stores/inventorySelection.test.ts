import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, type Writable } from "svelte/store";

import type { SavedSelection } from "../../../src/stores/inventorySelection.js";
import type { ParsedItem } from "../../../src/types/inventory.js";

const SAVED_KEY = "wf_inventory_saved_selections";

let store: Map<string, string>;

vi.mock("../../../src/stores/data.js", async () => {
  const { writable } = await import("svelte/store");
  return { parsedItems: writable([]) };
});

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

type SelectionModule = Awaited<ReturnType<typeof loadModule>>;

/** The completeness baseline reads the live inventory, so a case sets it first. */
async function setInventory(items: ParsedItem[]): Promise<void> {
  const data = await import("../../../src/stores/data.js");
  (data.parsedItems as unknown as Writable<ParsedItem[]>).set(items);
}

function ownedItem(internalName: string, amount: number): ParsedItem {
  return {
    name: internalName,
    internalName,
    category: "Misc",
    categoryLabel: "Misc",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    amount,
  };
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

describe("completion alert baseline", () => {
  const OWNED = "/Lotus/Test/Owned";
  const MISSING = "/Lotus/Test/Missing";

  function entry(mod: SelectionModule, name: string): SavedSelection | undefined {
    return get(mod.savedSelections).find((saved) => saved.name === name);
  }

  it("records an already complete set so switching the alert on does not notify", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 2)]);
    mod.selectKeys([OWNED]);
    mod.saveSelection("complete");

    mod.setSelectionAlert("complete", true);
    expect(entry(mod, "complete")).toEqual({
      name: "complete",
      keys: [OWNED],
      alertWhenComplete: true,
      lastComplete: true,
    });
  });

  it("arms an incomplete set instead of baselining it", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 1)]);
    mod.selectKeys([OWNED, MISSING]);
    mod.saveSelection("partial");

    mod.setSelectionAlert("partial", true);
    expect(entry(mod, "partial")?.alertWhenComplete).toBe(true);
    expect(entry(mod, "partial")?.lastComplete).toBeUndefined();
  });

  it("drops both flags when the alert goes off", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 1)]);
    mod.selectKeys([OWNED]);
    mod.saveSelection("off");
    mod.setSelectionAlert("off", true);

    mod.setSelectionAlert("off", false);
    expect(entry(mod, "off")).toEqual({ name: "off", keys: [OWNED] });
    expect(JSON.parse(store.get(SAVED_KEY) ?? "[]")).toEqual([{ name: "off", keys: [OWNED] }]);
  });

  it("ignores an alert switch for a name that is gone", async () => {
    const mod = await loadModule();
    mod.setSelectionAlert("missing", true);
    expect(get(mod.savedSelections)).toEqual([]);
  });

  it("re-baselines the carried alert against the keys the re-save wrote", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 1)]);
    mod.selectKeys([OWNED, MISSING]);
    mod.saveSelection("set");
    mod.setSelectionAlert("set", true);
    expect(entry(mod, "set")?.lastComplete).toBeUndefined();

    // Re-saving over the name narrows it to what the account owns, so the alert
    // must not fire on a completeness the user never crossed.
    mod.selectKeys([OWNED]);
    mod.saveSelection("set");
    expect(entry(mod, "set")).toEqual({
      name: "set",
      keys: [OWNED],
      alertWhenComplete: true,
      lastComplete: true,
    });

    // Widening it again re-arms: the new key set is not complete.
    mod.selectKeys([OWNED, MISSING]);
    mod.saveSelection("set");
    expect(entry(mod, "set")?.alertWhenComplete).toBe(true);
    expect(entry(mod, "set")?.lastComplete).toBeUndefined();
  });

  it("carries no alert flags into a re-save of a set that had none", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 1)]);
    mod.selectKeys([OWNED]);
    mod.saveSelection("plain");
    mod.saveSelection("plain");
    expect(entry(mod, "plain")).toEqual({ name: "plain", keys: [OWNED] });
  });

  it("leaves an armed alert armed while the inventory has not loaded", async () => {
    const mod = await loadModule();
    await setInventory([]);
    mod.selectKeys([OWNED]);
    mod.saveSelection("cold");
    mod.setSelectionAlert("cold", true);
    expect(entry(mod, "cold")?.lastComplete).toBeUndefined();

    // The first inventory push is the edge the alert fires on, so a re-save
    // after it baselines instead.
    await setInventory([ownedItem(OWNED, 1)]);
    mod.saveSelection("cold");
    expect(entry(mod, "cold")?.lastComplete).toBe(true);
  });

  it("records completeness in both directions", async () => {
    const mod = await loadModule();
    await setInventory([ownedItem(OWNED, 1)]);
    mod.selectKeys([OWNED]);
    mod.saveSelection("edge");
    mod.setSelectionAlert("edge", true);

    mod.recordSelectionCompleteness("edge", false);
    expect(entry(mod, "edge")?.lastComplete).toBeUndefined();
    mod.recordSelectionCompleteness("edge", true);
    expect(entry(mod, "edge")?.lastComplete).toBe(true);
  });
});
