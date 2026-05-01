import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundryData, ItemDbEntry, RawInventoryData } from "../types/inventory.js";

const parseFoundryMock = vi.hoisted(() => vi.fn<() => FoundryData>());
const parseInventoryMock = vi.hoisted(() => vi.fn(() => []));

vi.mock("../lib/inventory.js", () => ({
  parseInventory: parseInventoryMock,
}));

vi.mock("../lib/inventory/foundryResources.js", () => ({
  parseFoundry: parseFoundryMock,
}));

describe("foundryData", () => {
  beforeEach(() => {
    vi.resetModules();
    parseFoundryMock.mockReset();
    parseInventoryMock.mockClear();
  });

  it("does not parse Foundry data until a consumer subscribes", async () => {
    const foundryResult: FoundryData = { building: [], recipes: [] };
    parseFoundryMock.mockReturnValue(foundryResult);

    const stores = await import("./data.js");
    const inventory: RawInventoryData = {
      Recipes: [{ ItemType: "/Lotus/Recipes/TestBlueprint", ItemCount: 1 }],
    };
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Recipes/TestBlueprint": { name: "Test Blueprint" },
    };

    stores.inventoryData.set(inventory);
    stores.itemDb.set(db);

    expect(parseFoundryMock).not.toHaveBeenCalled();

    const unsubscribe = stores.foundryData.subscribe(() => {});

    expect(parseFoundryMock).toHaveBeenCalledTimes(1);
    expect(get(stores.foundryData)).toBe(foundryResult);

    unsubscribe();

    const unsubscribeAgain = stores.foundryData.subscribe(() => {});

    expect(parseFoundryMock).toHaveBeenCalledTimes(1);

    unsubscribeAgain();
  });
});
