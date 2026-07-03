import { describe, expect, it } from "vitest";

import {
  pickBoolean,
  parseAmount,
  extractEquipContexts,
  normalizeCollectionEntries,
  preferGroup,
  mergeOptionalBoolean,
  mergeEquipContexts,
} from "../../../../src/lib/inventory/entryNormalization.js";
import type { RawInventoryEntry, InventoryGroup } from "../../../../src/types/inventory.js";

describe("pickBoolean", () => {
  it("returns true for boolean true", () => {
    const entry = { mastered: true } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(true);
  });

  it("returns false for boolean false", () => {
    const entry = { mastered: false } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(false);
  });

  it("converts truthy numbers to true", () => {
    const entry = { mastered: 1 } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(true);
  });

  it("converts zero to false", () => {
    const entry = { mastered: 0 } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(false);
  });

  it('converts string "true" to true', () => {
    const entry = { mastered: "true" } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(true);
  });

  it('converts string "yes" to true', () => {
    const entry = { mastered: "yes" } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(true);
  });

  it('converts string "false" to false', () => {
    const entry = { mastered: "false" } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(false);
  });

  it('converts string "no" to false', () => {
    const entry = { mastered: "no" } as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBe(false);
  });

  it("returns undefined when key is missing", () => {
    const entry = {} as RawInventoryEntry;
    expect(pickBoolean(entry, ["mastered"])).toBeUndefined();
  });

  it("skips missing keys and returns the first valid one", () => {
    const entry = { flag2: true } as RawInventoryEntry;
    expect(pickBoolean(entry, ["flag1", "flag2"])).toBe(true);
  });
});

describe("parseAmount", () => {
  it("parses ItemCount", () => {
    const entry = { ItemCount: 5 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(5);
  });

  it("parses Count", () => {
    const entry = { Count: 3 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(3);
  });

  it("parses StackCount", () => {
    const entry = { StackCount: 10 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(10);
  });

  it("defaults to 1 when no count key present", () => {
    const entry = {} as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(1);
  });

  it("defaults to 1 for zero count", () => {
    const entry = { ItemCount: 0 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(1);
  });

  it("defaults to 1 for negative count", () => {
    const entry = { ItemCount: -5 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(1);
  });

  it("floors fractional amounts", () => {
    const entry = { ItemCount: 3.7 } as RawInventoryEntry;
    expect(parseAmount(entry)).toBe(3);
  });
});

describe("extractEquipContexts", () => {
  it("extracts equip names from known context keys", () => {
    const entry = { EquippedOn: "Excalibur Prime" } as RawInventoryEntry;
    const result = extractEquipContexts(entry);
    expect(result).toContain("Excalibur Prime");
  });

  it("filters out UUIDs", () => {
    const entry = {
      EquippedOn: "12345678-1234-1234-1234-123456789abc",
    } as RawInventoryEntry;
    expect(extractEquipContexts(entry)).toHaveLength(0);
  });

  it("filters out internal paths", () => {
    const entry = { EquippedOn: "/Lotus/Types/Items/Foo" } as RawInventoryEntry;
    expect(extractEquipContexts(entry)).toHaveLength(0);
  });

  it("limits to 4 entries", () => {
    const entry = {
      EquippedOn: "A Item",
      InstalledOn: "B Item",
      OwnerName: "C Item",
      HostItemName: "D Item",
      WeaponName: "E Item",
    } as RawInventoryEntry;
    expect(extractEquipContexts(entry).length).toBeLessThanOrEqual(4);
  });

  it("filters strings with brackets", () => {
    const entry = { EquippedOn: "[bracket string]" } as RawInventoryEntry;
    expect(extractEquipContexts(entry)).toHaveLength(0);
  });

  it("returns empty array when no context keys exist", () => {
    const entry = { Rank: 5 } as RawInventoryEntry;
    expect(extractEquipContexts(entry)).toEqual([]);
  });
});

describe("normalizeCollectionEntries", () => {
  it("returns entries from a flat array with ItemType", () => {
    const input = [
      { ItemType: "/Lotus/A", ItemCount: 1 },
      { ItemType: "/Lotus/B", ItemCount: 2 },
    ];
    const result = normalizeCollectionEntries(input);
    expect(result).toHaveLength(2);
    expect(result[0].ItemType).toBe("/Lotus/A");
  });

  it("flattens nested objects to find ItemType entries", () => {
    const input = {
      group1: [{ ItemType: "/Lotus/A" }],
      group2: { ItemType: "/Lotus/B" },
    };
    const result = normalizeCollectionEntries(input);
    expect(result).toHaveLength(2);
  });

  it("respects maxDepth limit", () => {
    const input = {
      a: { b: { c: { d: { ItemType: "/Lotus/Deep" } } } },
    };
    expect(normalizeCollectionEntries(input, 2)).toHaveLength(0);
    expect(normalizeCollectionEntries(input, 5)).toHaveLength(1);
  });

  it("returns empty for null/undefined", () => {
    expect(normalizeCollectionEntries(null)).toEqual([]);
    expect(normalizeCollectionEntries(undefined)).toEqual([]);
  });

  it("returns empty for non-objects", () => {
    expect(normalizeCollectionEntries("string")).toEqual([]);
    expect(normalizeCollectionEntries(42)).toEqual([]);
  });
});

describe("preferGroup", () => {
  it("returns next when current is undefined", () => {
    expect(preferGroup(undefined, "mods")).toBe("mods");
  });

  it("returns the higher-priority group", () => {
    expect(preferGroup("misc" as InventoryGroup, "mods")).toBe("mods");
  });

  it("keeps current when it has higher priority", () => {
    expect(preferGroup("relics" as InventoryGroup, "misc")).toBe("relics");
  });

  it("keeps current when priorities are equal", () => {
    expect(preferGroup("mods" as InventoryGroup, "mods")).toBe("mods");
  });
});

describe("mergeOptionalBoolean", () => {
  it("returns true when either value is true", () => {
    expect(mergeOptionalBoolean(true, false)).toBe(true);
    expect(mergeOptionalBoolean(false, true)).toBe(true);
    expect(mergeOptionalBoolean(true, undefined)).toBe(true);
  });

  it("returns false when either value is false and neither is true", () => {
    expect(mergeOptionalBoolean(false, undefined)).toBe(false);
    expect(mergeOptionalBoolean(undefined, false)).toBe(false);
  });

  it("returns undefined when both are undefined", () => {
    expect(mergeOptionalBoolean(undefined, undefined)).toBeUndefined();
  });
});

describe("mergeEquipContexts", () => {
  it("merges and deduplicates contexts", () => {
    const result = mergeEquipContexts(["Excalibur", "Rhino"], ["Rhino", "Frost"]);
    expect(result).toEqual(expect.arrayContaining(["Excalibur", "Rhino", "Frost"]));
    expect(result).toHaveLength(3);
  });

  it("filters out invalid entries during merge", () => {
    const result = mergeEquipContexts(["Excalibur"], ["12345678-1234-1234-1234-123456789abc"]);
    expect(result).toEqual(["Excalibur"]);
  });

  it("returns undefined when both are undefined/empty", () => {
    expect(mergeEquipContexts(undefined, undefined)).toBeUndefined();
    expect(mergeEquipContexts([], [])).toBeUndefined();
  });

  it("limits to 6 results", () => {
    const long = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
    const result = mergeEquipContexts(long, []);
    expect(result!.length).toBeLessThanOrEqual(6);
  });
});
