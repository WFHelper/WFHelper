import { describe, expect, it } from "vitest";

import { parseFoundry } from "../../../../src/lib/inventory.js";
import { foundryReadyRows, withRowKeys } from "../../../../src/lib/widgets/rows.js";
import type { ItemDbEntry, RawInventoryData } from "../../../../src/types/inventory.js";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const FORMA = "/Lotus/Types/Items/MiscItems/Forma";
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";

describe("foundryReadyRows", () => {
  it("keys two finished builds of the same blueprint apart", () => {
    const db: Record<string, ItemDbEntry> = {
      [FORMA]: {
        name: "Forma",
        recipe: {
          buildPrice: 0,
          buildTime: 0,
          num: 1,
          blueprintUniqueName: FORMA_BP,
          ingredients: [],
        },
      },
      [FORMA_BP]: { name: "Forma Blueprint" },
    };
    const done = { $date: { $numberLong: String(NOW - 60_000) } };
    const data: RawInventoryData = {
      PendingRecipes: [
        { ItemType: FORMA_BP, CompletionDate: done },
        { ItemType: FORMA_BP, CompletionDate: done },
      ],
    };

    const rows = foundryReadyRows(parseFoundry(data, db), new Map(), new Set(), NOW);

    expect(rows.map((row) => row.name)).toEqual(["Forma", "Forma"]);
    expect(new Set(rows.map((row) => row.rowKey)).size).toBe(2);
  });
});

describe("withRowKeys", () => {
  it("keeps the first key and never reuses one a later row already holds", () => {
    const rows = [{ id: "a" }, { id: "a" }, { id: "a#2" }];
    const keys = withRowKeys(rows, (row) => row.id).map((row) => row.rowKey);
    expect(keys[0]).toBe("a");
    expect(new Set(keys).size).toBe(3);
  });
});
