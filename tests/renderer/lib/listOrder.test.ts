import { describe, expect, it } from "vitest";

import { moveIndex } from "../../../src/lib/listOrder.js";

describe("moveIndex", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an entry forward and backward", () => {
    expect(moveIndex(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps the target into the list", () => {
    expect(moveIndex(list, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveIndex(list, 2, -5)).toEqual(["c", "a", "b", "d"]);
  });

  it("returns the same array when nothing moves", () => {
    expect(moveIndex(list, 1, 1)).toBe(list);
    expect(moveIndex(list, 3, 99)).toBe(list);
    expect(moveIndex(list, -1, 2)).toBe(list);
    expect(moveIndex(list, 4, 0)).toBe(list);
    expect(moveIndex([], 0, 0)).toEqual([]);
  });

  it("never mutates the input", () => {
    const copy = list.slice();
    moveIndex(list, 0, 3);
    expect(list).toEqual(copy);
  });
});
