import { describe, expect, it } from "vitest";

import {
  selectionOwnership,
  selectionTransitions,
} from "../../../../src/lib/inventory/selectionAlerts.js";
import type { SavedSelection } from "../../../../src/stores/inventorySelection.js";
import type { ParsedItem } from "../../../../src/types/inventory.js";

function item(overrides: Partial<ParsedItem> & { internalName: string }): ParsedItem {
  return {
    name: overrides.internalName,
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
    ...overrides,
  };
}

function selection(overrides: Partial<SavedSelection> = {}): SavedSelection {
  return { name: "set", keys: ["a", "b"], ...overrides };
}

describe("selectionOwnership", () => {
  it("counts a key as owned when a matching item has units", () => {
    const items = [item({ internalName: "a", amount: 3 }), item({ internalName: "b", amount: 1 })];
    expect(selectionOwnership(selection(), items)).toEqual({ owned: 2, total: 2, complete: true });
  });

  it("treats a zero-amount or unowned row as missing", () => {
    const items = [
      item({ internalName: "a", amount: 0 }),
      item({ internalName: "b", currentlyOwned: false }),
    ];
    expect(selectionOwnership(selection(), items)).toEqual({ owned: 0, total: 2, complete: false });
  });

  it("owns an unstacked row through currentlyOwned", () => {
    const items = [item({ internalName: "a", currentlyOwned: true })];
    expect(selectionOwnership(selection({ keys: ["a"] }), items)).toEqual({
      owned: 1,
      total: 1,
      complete: true,
    });
  });

  it("prefers inventoryKey over internalName for the join", () => {
    const items = [item({ internalName: "wrong", inventoryKey: "a", amount: 2 })];
    expect(selectionOwnership(selection({ keys: ["a"] }), items).complete).toBe(true);
  });

  it("never calls an empty selection complete", () => {
    expect(selectionOwnership(selection({ keys: [] }), [])).toEqual({
      owned: 0,
      total: 0,
      complete: false,
    });
  });

  it("counts a duplicated key once", () => {
    const items = [item({ internalName: "a", amount: 1 })];
    expect(selectionOwnership(selection({ keys: ["a", "a"] }), items)).toEqual({
      owned: 1,
      total: 1,
      complete: true,
    });
  });
});

describe("selectionTransitions", () => {
  const owned = [item({ internalName: "a", amount: 1 }), item({ internalName: "b", amount: 1 })];

  it("fires for a flagged selection that is complete and was not", () => {
    const entry = selection({ alertWhenComplete: true });
    expect(selectionTransitions([entry], owned)).toEqual([entry]);
  });

  it("skips an unflagged selection", () => {
    expect(selectionTransitions([selection()], owned)).toEqual([]);
  });

  it("skips a selection that was already complete", () => {
    const entry = selection({ alertWhenComplete: true, lastComplete: true });
    expect(selectionTransitions([entry], owned)).toEqual([]);
  });

  it("skips a flagged selection that is still incomplete", () => {
    const entry = selection({ alertWhenComplete: true });
    expect(selectionTransitions([entry], [owned[0]])).toEqual([]);
  });

  it("fires again after the selection dropped back to incomplete", () => {
    const entry = selection({ alertWhenComplete: true, lastComplete: false });
    expect(selectionTransitions([entry], owned)).toEqual([entry]);
  });

  it("returns every flagged selection that crossed at once", () => {
    const first = selection({ name: "one", alertWhenComplete: true });
    const second = selection({ name: "two", keys: ["a"], alertWhenComplete: true });
    expect(selectionTransitions([first, second], owned)).toEqual([first, second]);
  });
});
