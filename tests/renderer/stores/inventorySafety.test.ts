import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import type { InventorySafetySettings } from "../../../src/lib/inventory/safetyRules.js";

const STORAGE_KEY = "inventory.safety";
const MOD = "/Lotus/Upgrades/Mods/Serration";
const FRAME = "/Lotus/Powersuits/Volt/VoltPrime";

let store: Map<string, string>;

/** The module reads storage once at import, so every case needs a fresh copy. */
async function loadStore(stored?: string) {
  store = new Map();
  if (stored !== undefined) store.set(STORAGE_KEY, stored);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.resetModules();
  return await import("../../../src/stores/inventorySafety.js");
}

function persisted(): InventorySafetySettings {
  return JSON.parse(store.get(STORAGE_KEY) ?? "{}");
}

beforeEach(() => {
  store = new Map();
});

afterEach(() => vi.unstubAllGlobals());

describe("loading", () => {
  it("starts from the defaults with nothing stored", async () => {
    const { inventorySafety } = await loadStore();
    expect(get(inventorySafety)).toEqual({
      spareDefault: 0,
      spares: {},
      locks: [],
      setKeep: [],
    });
  });

  it("restores a stored blob", async () => {
    const { inventorySafety } = await loadStore(
      JSON.stringify({ spareDefault: 2, spares: { [MOD]: 5 }, locks: [FRAME], setKeep: [FRAME] }),
    );
    expect(get(inventorySafety)).toEqual({
      spareDefault: 2,
      spares: { [MOD]: 5 },
      locks: [FRAME],
      setKeep: [FRAME],
    });
  });

  it("falls back to the defaults on unparseable JSON", async () => {
    const { inventorySafety } = await loadStore("{not json");
    expect(get(inventorySafety)).toEqual({ spareDefault: 0, spares: {}, locks: [], setKeep: [] });
  });

  it("drops the junk out of a partly valid blob", async () => {
    const { inventorySafety } = await loadStore(
      JSON.stringify({ spareDefault: "two", spares: { [MOD]: "x", [FRAME]: 3 }, locks: [1, MOD] }),
    );
    expect(get(inventorySafety)).toEqual({
      spareDefault: 0,
      spares: { [FRAME]: 3 },
      locks: [MOD],
      setKeep: [],
    });
  });

  it("degrades a stored array to the defaults", async () => {
    const { inventorySafety } = await loadStore(JSON.stringify([MOD, FRAME]));
    expect(get(inventorySafety)).toEqual({ spareDefault: 0, spares: {}, locks: [], setKeep: [] });
  });

  it("survives a missing localStorage", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const { inventorySafety, toggleSafetyLock } =
      await import("../../../src/stores/inventorySafety.js");
    toggleSafetyLock(MOD);
    expect(get(inventorySafety).locks).toEqual([MOD]);
  });
});

describe("writes", () => {
  it("toggles a lock on and off", async () => {
    const { inventorySafety, toggleSafetyLock } = await loadStore();
    toggleSafetyLock(MOD);
    expect(get(inventorySafety).locks).toEqual([MOD]);
    expect(persisted().locks).toEqual([MOD]);
    toggleSafetyLock(MOD);
    expect(get(inventorySafety).locks).toEqual([]);
  });

  it("ignores an empty key", async () => {
    const { inventorySafety, toggleSafetyLock, toggleSetKeep, setItemSpare } = await loadStore();
    toggleSafetyLock("");
    toggleSetKeep("");
    setItemSpare("", 3);
    expect(get(inventorySafety)).toEqual({ spareDefault: 0, spares: {}, locks: [], setKeep: [] });
  });

  it("sets and clears a per-item spare", async () => {
    const { inventorySafety, setItemSpare } = await loadStore();
    setItemSpare(MOD, 4);
    expect(get(inventorySafety).spares).toEqual({ [MOD]: 4 });
    setItemSpare(MOD, 0);
    expect(get(inventorySafety).spares).toEqual({ [MOD]: 0 });
    setItemSpare(MOD, null);
    expect(get(inventorySafety).spares).toEqual({});
  });

  it("normalizes what a caller passes in", async () => {
    const { inventorySafety, setSpareDefault, setItemSpare } = await loadStore();
    setSpareDefault(-3);
    setItemSpare(MOD, 2.9);
    expect(get(inventorySafety)).toMatchObject({ spareDefault: 0, spares: { [MOD]: 2 } });
    setSpareDefault(5000);
    expect(get(inventorySafety).spareDefault).toBe(999);
  });

  it("toggles a set-keep flag", async () => {
    const { inventorySafety, toggleSetKeep } = await loadStore();
    toggleSetKeep(FRAME);
    expect(get(inventorySafety).setKeep).toEqual([FRAME]);
    toggleSetKeep(FRAME);
    expect(get(inventorySafety).setKeep).toEqual([]);
  });

  it("resets everything", async () => {
    const { inventorySafety, resetInventorySafety, setSpareDefault, toggleSafetyLock } =
      await loadStore();
    setSpareDefault(3);
    toggleSafetyLock(MOD);
    resetInventorySafety();
    expect(get(inventorySafety)).toEqual({ spareDefault: 0, spares: {}, locks: [], setKeep: [] });
    expect(persisted()).toEqual({ spareDefault: 0, spares: {}, locks: [], setKeep: [] });
  });

  it("feeds buildSafetyContext without adaptation", async () => {
    const { inventorySafety, setSpareDefault, toggleSafetyLock } = await loadStore();
    setSpareDefault(2);
    toggleSafetyLock(MOD);
    const { buildSafetyContext, safeToList } =
      await import("../../../src/lib/inventory/safetyRules.js");
    const context = buildSafetyContext({
      itemDb: {},
      settings: get(inventorySafety),
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList({ internalName: MOD, uniqueName: MOD, amount: 6 }, context).safe).toBe(0);
    expect(safeToList({ internalName: FRAME, amount: 6 }, context).safe).toBe(4);
  });
});
