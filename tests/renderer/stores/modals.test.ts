import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildParsedItemFromDb } from "../../../src/lib/parsedItemFromDb.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";
import type { RelicDatabase, RelicGroup } from "../../../src/types/relics.js";

const STORAGE_KEY = "wf_relic_view";
const INTACT = "/Lotus/Types/Game/Projections/T1VoidProjectionFixtureBronze";
const NEW_RELIC = "/Lotus/Types/Game/Projections/T1VoidProjectionNewBronze";
const RIFLE = "/Lotus/Weapons/Fixture";

const lithZ9: RelicGroup = {
  key: "Lith Z9",
  name: "Lith Z9",
  tier: "Lith",
  code: "Z9",
  imageUrl: null,
  qualities: {
    intact: {
      uniqueName: INTACT,
      rewards: [{ name: "Fixture Barrel", rarity: "Rare", chance: 2, urlName: null, ducats: 100 }],
    },
  },
};
const lithN1: RelicGroup = {
  key: "Lith N1",
  name: "Lith N1",
  tier: "Lith",
  code: "N1",
  imageUrl: null,
  qualities: { intact: { uniqueName: NEW_RELIC, rewards: [] } },
};
const relics: RelicDatabase = {
  groups: { "Lith Z9": lithZ9, "Lith N1": lithN1 },
  byUniqueName: {
    [INTACT]: { groupKey: "Lith Z9", quality: "intact" },
    [NEW_RELIC]: { groupKey: "Lith N1", quality: "intact" },
  },
};
const db: Record<string, ItemDbEntry> = {
  [INTACT]: { name: "Lith Z9 Relic", category: "Relics" },
  [NEW_RELIC]: { name: "Lith N1 Relic", category: "Relic" },
  [RIFLE]: { name: "Fixture Rifle", category: "Primary" },
};
const item = (uniqueName: string) => buildParsedItemFromDb(uniqueName, db[uniqueName], new Map());

async function loadModals(stored: string | null) {
  const mem = new Map<string, string>();
  if (stored !== null) mem.set(STORAGE_KEY, stored);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  vi.resetModules();
  const modals = await import("../../../src/stores/modals.js");
  const { relicDb } = await import("../../../src/stores/relics.js");
  const { itemDb } = await import("../../../src/stores/data.js");
  const { relicViewPreference } = await import("../../../src/stores/relicView.js");
  relicDb.set(relics);
  itemDb.set(db);
  return { ...modals, relicViewPreference, mem };
}

describe("relic view routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps each tab's own popup until the switch has been used", async () => {
    const m = await loadModals(null);
    expect(get(m.relicViewPreference)).toBe("auto");
    m.activeItem.set(item(INTACT));
    expect(get(m.activeItem)?.uniqueName).toBe(INTACT);
    expect(get(m.activeRelic)).toBeNull();
    m.activeItem.set(null);
    m.activeRelic.set(lithZ9);
    expect(get(m.activeRelic)).toBe(lithZ9);
    expect(get(m.activeItem)).toBeNull();
  });

  it("opens every relic as the breakdown once detailed is remembered", async () => {
    const m = await loadModals("detailed");
    m.activeItem.set(item(RIFLE));
    m.activeItem.set(item(INTACT));
    expect(get(m.activeItem)).toBeNull();
    expect(get(m.activeRelic)).toBe(lithZ9);
    m.activeRelic.set(null);
    m.activeItem.update(() => item(INTACT));
    expect(get(m.activeRelic)).toBe(lithZ9);
  });

  it("never offers a breakdown for a relic without reward rows", async () => {
    const m = await loadModals("detailed");
    m.activeItem.set(item(NEW_RELIC));
    expect(get(m.activeItem)?.uniqueName).toBe(NEW_RELIC);
    expect(get(m.activeRelic)).toBeNull();
    m.activeItem.set(null);
    m.activeRelic.set(lithN1);
    expect(get(m.activeRelic)).toBeNull();
    expect(get(m.activeItem)?.uniqueName).toBe(NEW_RELIC);
  });

  it("opens every relic as the item popup once simple is remembered", async () => {
    const m = await loadModals("simple");
    m.activeRelic.set(lithZ9);
    expect(get(m.activeRelic)).toBeNull();
    expect(get(m.activeItem)?.uniqueName).toBe(INTACT);
    m.activeItem.set(item(INTACT));
    expect(get(m.activeItem)?.uniqueName).toBe(INTACT);
    expect(get(m.activeRelic)).toBeNull();
  });

  it("keeps the breakdown when no item entry exists for a simple popup", async () => {
    const m = await loadModals("simple");
    const unknown: RelicGroup = {
      ...lithZ9,
      key: "Axi Q0",
      qualities: { intact: { uniqueName: "/x", rewards: [] } },
    };
    m.activeRelic.set(unknown);
    expect(get(m.activeRelic)).toBe(unknown);
    expect(get(m.activeItem)).toBeNull();
  });

  it("swaps the open popup without leaving both open", async () => {
    const m = await loadModals("simple");
    m.openRelicDetailed(lithZ9);
    expect(get(m.activeItem)).toBeNull();
    expect(get(m.activeRelic)).toBe(lithZ9);
    m.openRelicSimple(item(INTACT));
    expect(get(m.activeRelic)).toBeNull();
    expect(get(m.activeItem)?.uniqueName).toBe(INTACT);
  });

  it("clears both stores on close", async () => {
    const m = await loadModals("detailed");
    m.activeItem.set(item(INTACT));
    m.activeRelic.set(null);
    expect(get(m.activeRelic)).toBeNull();
    expect(get(m.activeItem)).toBeNull();
  });

  it("follows a choice made in another window", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const m = await loadModals(null);
    m.mem.set(STORAGE_KEY, "simple");
    target.dispatchEvent(Object.assign(new Event("storage"), { key: STORAGE_KEY }));
    expect(get(m.relicViewPreference)).toBe("simple");
    m.activeRelic.set(lithZ9);
    expect(get(m.activeItem)?.uniqueName).toBe(INTACT);
  });

  it("persists the remembered view and degrades an unknown value to auto", async () => {
    const m = await loadModals("sideways");
    expect(get(m.relicViewPreference)).toBe("auto");
    m.relicViewPreference.set("detailed");
    expect(m.mem.get(STORAGE_KEY)).toBe("detailed");
  });
});
