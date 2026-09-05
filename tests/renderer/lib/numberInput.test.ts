import { describe, expect, it } from "vitest";

import { inputText, numOrUndef } from "../../../src/lib/numberInput.js";

describe("numOrUndef", () => {
  it("reads the number a bound field holds", () => {
    expect(numOrUndef(12)).toBe(12);
    expect(numOrUndef(" 12.5 ")).toBe(12.5);
    expect(numOrUndef("0")).toBe(0);
    expect(numOrUndef(-3)).toBe(-3);
  });

  it("treats a cleared or unreadable field as no value", () => {
    // A cleared type="number" input binds null whatever the declared type is.
    expect(numOrUndef(null)).toBeUndefined();
    expect(numOrUndef(undefined)).toBeUndefined();
    expect(numOrUndef("")).toBeUndefined();
    expect(numOrUndef("   ")).toBeUndefined();
    expect(numOrUndef("abc")).toBeUndefined();
    expect(numOrUndef(Number.NaN)).toBeUndefined();
    expect(numOrUndef(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("inputText", () => {
  it("trims, and reads a cleared field as the empty string", () => {
    expect(inputText(" 7 ")).toBe("7");
    expect(inputText(0)).toBe("0");
    expect(inputText(null)).toBe("");
    expect(inputText(undefined)).toBe("");
    expect(inputText("   ")).toBe("");
  });
});
