import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
  masteryPinKeepMastered,
  masteryPins,
  restoreMasteryPins,
  toggleMasteryPin,
  unpinMasteryItems,
} from "../../../src/stores/masteryPins.js";

const PIN_KEY = "mastery.pinnedItems";

/** A fresh copy of the store over a seeded localStorage, plus the keys it wrote. */
async function loadWithStorage(seed: Record<string, string> = {}) {
  const mem = new Map(Object.entries(seed));
  const writes: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      mem.set(key, value);
    },
  });
  vi.resetModules();
  return { store: await import("../../../src/stores/masteryPins.js"), mem, writes };
}

function pinNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/p${index}`);
}

describe("mastery pins", () => {
  beforeEach(() => {
    masteryPins.set([]);
    unpinMasteryItems(get(masteryPinKeepMastered));
  });

  it("adds and removes a pin with the same toggle", () => {
    toggleMasteryPin("/Lotus/Weapons/Alpha");
    expect(get(masteryPins)).toEqual(["/Lotus/Weapons/Alpha"]);
    toggleMasteryPin("/Lotus/Weapons/Alpha");
    expect(get(masteryPins)).toEqual([]);
  });

  it("ignores an empty uniqueName", () => {
    toggleMasteryPin("");
    expect(get(masteryPins)).toEqual([]);
  });

  it("drops several pins in one write", () => {
    masteryPins.set(["/a", "/b", "/c"]);
    unpinMasteryItems(["/a", "/c"]);
    expect(get(masteryPins)).toEqual(["/b"]);
  });

  it("leaves the list alone when nothing is dropped", () => {
    masteryPins.set(["/a"]);
    unpinMasteryItems([]);
    expect(get(masteryPins)).toEqual(["/a"]);
  });

  it("drops duplicates a set or a corrupt list would introduce", () => {
    masteryPins.set(["/a", "/b", "/a"]);
    expect(get(masteryPins)).toEqual(["/a", "/b"]);
    masteryPins.update((list) => [...list, "/b"]);
    expect(get(masteryPins)).toEqual(["/a", "/b"]);
  });
});

describe("mastery pin mastered exemptions", () => {
  beforeEach(() => {
    masteryPins.set([]);
    unpinMasteryItems(get(masteryPinKeepMastered));
  });

  it("restores only the items of one drop event and keeps them exempt", () => {
    masteryPins.set(["/a", "/b", "/c"]);

    unpinMasteryItems(["/a"]);
    unpinMasteryItems(["/b"]);
    // Undoing the first event must not resurrect the second event's pin.
    restoreMasteryPins(["/a"]);

    expect(get(masteryPins).sort()).toEqual(["/a", "/c"]);
    expect(get(masteryPinKeepMastered)).toEqual(["/a"]);
  });

  it("marks a manual pin of a mastered item as exempt and prunes it on unpin", () => {
    toggleMasteryPin("/a", true);
    expect(get(masteryPinKeepMastered)).toEqual(["/a"]);

    toggleMasteryPin("/a");
    expect(get(masteryPins)).toEqual([]);
    // An exemption for an item that is no longer pinned would resurrect later.
    expect(get(masteryPinKeepMastered)).toEqual([]);
  });

  it("does not exempt an ordinary manual pin", () => {
    toggleMasteryPin("/a");
    expect(get(masteryPinKeepMastered)).toEqual([]);
  });
});

describe("mastery pins loaded from storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dedupes a hand-edited list before the planner keys on it", async () => {
    const raw = JSON.stringify(["/a", "/b", "/a"]);
    const { store, mem, writes } = await loadWithStorage({ [PIN_KEY]: raw });

    expect(get(store.masteryPins)).toEqual(["/a", "/b"]);
    // Dedupe is a read-side fix, so opening the app rewrites nothing.
    expect(writes).toEqual([]);
    expect(mem.get(PIN_KEY)).toBe(raw);
  });

  it("dedupes the keep-mastered list on read", async () => {
    const { store } = await loadWithStorage({
      "mastery.pinnedKeepMastered": JSON.stringify(["/a", "/a", "/b"]),
    });

    expect(get(store.masteryPinKeepMastered)).toEqual(["/a", "/b"]);
  });

  it("writes only once the user changes a pin", async () => {
    const { store, writes } = await loadWithStorage();

    expect(writes).toEqual([]);
    store.toggleMasteryPin("/a");
    expect(get(store.masteryPins)).toEqual(["/a"]);
    expect(writes).toContain(PIN_KEY);
  });
});

describe("mastery pins at the cap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("trims the restore rather than evicting pins the user still has", async () => {
    const full = pinNames(40);
    const { store } = await loadWithStorage({ [PIN_KEY]: JSON.stringify(full) });

    store.restoreMasteryPins(["/undone1", "/undone2"]);

    expect(get(store.masteryPins)).toEqual(full);
  });

  it("re-pins as many undone drops as fit", async () => {
    const nearlyFull = pinNames(39);
    const { store } = await loadWithStorage({ [PIN_KEY]: JSON.stringify(nearlyFull) });

    store.restoreMasteryPins(["/undone1", "/undone2"]);

    expect(get(store.masteryPins)).toEqual([...nearlyFull, "/undone1"]);
  });

  it("round-trips an auto-unpin and its undo at the cap", async () => {
    const full = pinNames(40);
    const { store } = await loadWithStorage({ [PIN_KEY]: JSON.stringify(full) });

    store.unpinMasteryItems(["/p0", "/p1"]);
    expect(get(store.masteryPins)).toEqual(full.slice(2));

    store.restoreMasteryPins(["/p0", "/p1"]);
    expect(get(store.masteryPins)).toEqual([...full.slice(2), "/p0", "/p1"]);
    expect(get(store.masteryPinKeepMastered)).toEqual(["/p0", "/p1"]);
  });
});
