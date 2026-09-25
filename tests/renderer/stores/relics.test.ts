import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DropInfo, RawInventoryData } from "../../../src/types/inventory.js";
import type { RelicDatabase, RelicGroup } from "../../../src/types/relics.js";

vi.mock("../../../src/lib/ipc.js", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

function projection(code: string, quality: string): string {
  return `/Lotus/Types/Game/Projections/T4Void${code}${quality}`;
}

function axiGroup(code: string): RelicGroup {
  const key = `Axi ${code}`;
  return {
    key,
    name: key,
    tier: "Axi",
    code,
    imageUrl: null,
    qualities: {
      intact: { uniqueName: projection(code, "Bronze"), rewards: [] },
      radiant: { uniqueName: projection(code, "Platinum"), rewards: [] },
    },
  };
}

const relics: RelicDatabase = {
  groups: { "Axi A1": axiGroup("A1"), "Axi A10": axiGroup("A10") },
  byUniqueName: {
    [projection("A1", "Bronze")]: { groupKey: "Axi A1", quality: "intact" },
    [projection("A1", "Platinum")]: { groupKey: "Axi A1", quality: "radiant" },
    [projection("A10", "Bronze")]: { groupKey: "Axi A10", quality: "intact" },
    [projection("A10", "Platinum")]: { groupKey: "Axi A10", quality: "radiant" },
  },
};

const threeAxiA10: RawInventoryData = {
  MiscItems: [{ ItemType: projection("A10", "Bronze"), ItemCount: 3 }],
};

const drops: DropInfo[] = [
  { location: "Axi A1 Relic", rarity: "Common", chance: 0.2533 },
  { location: "Axi A10 Relic", rarity: "Rare", chance: 0.02 },
];

async function loadStores() {
  const actions = await import("../../../src/lib/actions.js");
  const data = await import("../../../src/stores/data.js");
  const relicStores = await import("../../../src/stores/relics.js");
  const { ownedRelicDropsFirst } = await import("../../../src/lib/resolveDrops.js");
  const dropOrder = (): string[] =>
    ownedRelicDropsFirst(drops, get(relicStores.relicDb), get(relicStores.relicOwnedCounts)).map(
      (drop) => drop.location,
    );
  return { ...actions, ...data, ...relicStores, dropOrder };
}

describe("relicOwnedCounts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("promotes an owned relic drop when the database arrives after the inventory", async () => {
    const stores = await loadStores();

    await stores.onInventoryLoaded(threeAxiA10);
    stores.relicDb.set(relics);

    expect(get(stores.relicOwnedCounts)["Axi A10"]).toEqual({
      intact: 3,
      exceptional: 0,
      flawless: 0,
      radiant: 0,
    });
    expect(stores.dropOrder()).toEqual(["Axi A10 Relic", "Axi A1 Relic"]);
  });

  it("promotes an owned relic drop when the inventory arrives after the database", async () => {
    const stores = await loadStores();

    stores.relicDb.set(relics);
    await stores.onInventoryLoaded(threeAxiA10);

    expect(get(stores.relicOwnedCounts)["Axi A10"]?.intact).toBe(3);
    expect(stores.dropOrder()).toEqual(["Axi A10 Relic", "Axi A1 Relic"]);
  });

  it("forgets the counts when the inventory is removed", async () => {
    const stores = await loadStores();
    stores.relicDb.set(relics);
    await stores.onInventoryLoaded(threeAxiA10);
    expect(stores.dropOrder()).toEqual(["Axi A10 Relic", "Axi A1 Relic"]);

    stores.inventoryData.set(null);

    expect(get(stores.relicOwnedCounts)).toEqual({});
    expect(stores.dropOrder()).toEqual(["Axi A1 Relic", "Axi A10 Relic"]);
  });
});
