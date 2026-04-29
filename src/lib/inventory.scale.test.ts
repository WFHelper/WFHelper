import { describe, expect, it } from "vitest";

import { parseInventory } from "./inventory.js";
import type { ItemDbEntry, RawInventoryData, RawInventoryEntry } from "../types/inventory.js";

const LARGE_INVENTORY_ITEM_COUNT = 12_000;

function buildLargeInventoryFixture(): {
  data: RawInventoryData;
  itemDb: Record<string, ItemDbEntry>;
} {
  const miscItems: RawInventoryEntry[] = [];
  const itemDb: Record<string, ItemDbEntry> = {};

  for (let index = 0; index < LARGE_INVENTORY_ITEM_COUNT; index += 1) {
    const uniqueName = `/Lotus/Test/Items/LargeInventoryItem${index}`;
    miscItems.push({ ItemType: uniqueName, ItemCount: (index % 5) + 1 });
    itemDb[uniqueName] = {
      name: `Large Inventory Item ${index}`,
      category: "Misc",
      tradable: index % 3 === 0,
    };
  }

  return {
    data: { MiscItems: miscItems },
    itemDb,
  };
}

describe("inventory parser scale", () => {
  it("handles a large synthetic inventory without dropping entries", () => {
    const { data, itemDb } = buildLargeInventoryFixture();
    const startedAt = performance.now();
    const parsedItems = parseInventory(data, itemDb);
    const elapsedMs = performance.now() - startedAt;

    console.log(
      `\n  Large inventory parse: ${parsedItems.length.toLocaleString()} items in ${elapsedMs.toFixed(0)} ms`,
    );

    expect(parsedItems).toHaveLength(LARGE_INVENTORY_ITEM_COUNT);
    expect(parsedItems[0]).toMatchObject({
      name: "Large Inventory Item 0",
      amount: 1,
      inventoryGroup: "misc",
    });
    expect(parsedItems[LARGE_INVENTORY_ITEM_COUNT - 1]?.name).toBe(
      `Large Inventory Item ${LARGE_INVENTORY_ITEM_COUNT - 1}`,
    );
  });
});