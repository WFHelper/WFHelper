import { describe, it, expect } from "vitest";
import {
  MAX_SUPPORTED_RANK,
  RANKED_GROUPS,
  toFiniteNumber,
  toFiniteOr,
  clampNumber,
  normalizeRank,
  normalizeRankFilter,
  normalizeDucats,
  toFinitePositiveInt,
  toFiniteNonNegativeInt,
  isRankedGroup,
} from "../../config/shared/numeric";

describe("toFiniteNumber", () => {
  it("returns finite numbers as-is", () => {
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber(-3.5)).toBe(-3.5);
  });

  it("rejects non-finite numbers", () => {
    expect(toFiniteNumber(NaN)).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
    expect(toFiniteNumber(-Infinity)).toBeNull();
  });

  it("parses non-empty strings", () => {
    expect(toFiniteNumber("7")).toBe(7);
    expect(toFiniteNumber("  3.14  ")).toBe(3.14);
    expect(toFiniteNumber("-1")).toBe(-1);
  });

  it("rejects empty/whitespace-only strings", () => {
    expect(toFiniteNumber("")).toBeNull();
    expect(toFiniteNumber("   ")).toBeNull();
  });

  it("rejects unparseable strings", () => {
    expect(toFiniteNumber("abc")).toBeNull();
    expect(toFiniteNumber("NaN")).toBeNull();
    expect(toFiniteNumber("Infinity")).toBeNull();
  });

  it("unwraps BSON-style boxed numbers", () => {
    expect(toFiniteNumber({ $numberInt: "5" })).toBe(5);
    expect(toFiniteNumber({ $numberLong: "1000" })).toBe(1000);
    expect(toFiniteNumber({ $numberDouble: "2.5" })).toBe(2.5);
    expect(toFiniteNumber({ $numberDecimal: "99.9" })).toBe(99.9);
    expect(toFiniteNumber({ $numberFloat: "1.1" })).toBe(1.1);
  });

  it("recursively unwraps nested BSON objects", () => {
    expect(toFiniteNumber({ $numberInt: { $numberLong: "42" } })).toBe(42);
  });

  it("rejects non-coercible inputs", () => {
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber(true)).toBeNull();
    expect(toFiniteNumber(false)).toBeNull();
    expect(toFiniteNumber([])).toBeNull();
    expect(toFiniteNumber({})).toBeNull();
  });
});

describe("toFiniteOr", () => {
  it("returns valid number directly", () => {
    expect(toFiniteOr(5, 0)).toBe(5);
  });

  it("returns fallback for null/undefined", () => {
    expect(toFiniteOr(null, -1)).toBe(-1);
    expect(toFiniteOr(undefined, 99)).toBe(99);
  });

  it("defaults fallback to 0", () => {
    expect(toFiniteOr(null)).toBe(0);
  });
});

describe("clampNumber", () => {
  it("clamps below min", () => {
    expect(clampNumber(-5, 0, 10)).toBe(0);
  });

  it("clamps above max", () => {
    expect(clampNumber(15, 0, 10)).toBe(10);
  });

  it("returns value within range", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
  });

  it("returns fallback when value is not finite (4-arg form)", () => {
    expect(clampNumber("abc", 0, 10, 5)).toBe(5);
    expect(clampNumber(NaN, 0, 10, 7)).toBe(7);
    expect(clampNumber(undefined, 0, 1, 0)).toBe(0);
    expect(clampNumber(Infinity, 0, 100, 50)).toBe(50);
  });

  it("coerces string to number in 4-arg form", () => {
    expect(clampNumber("3", 0, 10, 5)).toBe(3);
    expect(clampNumber("15", 0, 10, 5)).toBe(10);
    expect(clampNumber("-2", 0, 10, 5)).toBe(0);
  });

  it("clamps normally when value is finite in 4-arg form", () => {
    expect(clampNumber(5, 0, 10, 99)).toBe(5);
  });
});

describe("normalizeRank", () => {
  it("floors valid positive numbers", () => {
    expect(normalizeRank(3.7)).toBe(3);
    expect(normalizeRank(0)).toBe(0);
  });

  it("rejects negative values", () => {
    expect(normalizeRank(-1)).toBeNull();
  });

  it("rejects null/undefined", () => {
    expect(normalizeRank(null)).toBeNull();
    expect(normalizeRank(undefined)).toBeNull();
  });

  it("rejects empty strings", () => {
    expect(normalizeRank("")).toBeNull();
    expect(normalizeRank("  ")).toBeNull();
  });

  it("parses string values", () => {
    expect(normalizeRank("5")).toBe(5);
  });

  it("enforces optional maxRank upper bound", () => {
    expect(normalizeRank(25, 20)).toBeNull();
    expect(normalizeRank(20, 20)).toBe(20);
    expect(normalizeRank(19, 20)).toBe(19);
  });

  it("passes without maxRank", () => {
    expect(normalizeRank(100)).toBe(100);
  });
});

describe("normalizeRankFilter", () => {
  it("clamps to MAX_SUPPORTED_RANK", () => {
    expect(normalizeRankFilter(20)).toBe(20);
    expect(normalizeRankFilter(21)).toBeNull();
  });

  it("rejects negative", () => {
    expect(normalizeRankFilter(-1)).toBeNull();
  });

  it("parses strings", () => {
    expect(normalizeRankFilter("5")).toBe(5);
  });
});

describe("toFinitePositiveInt", () => {
  it("accepts positive numbers and floors them", () => {
    expect(toFinitePositiveInt(3.9)).toBe(3);
    expect(toFinitePositiveInt(1)).toBe(1);
  });

  it("rejects zero", () => {
    expect(toFinitePositiveInt(0)).toBeNull();
  });

  it("rejects negative", () => {
    expect(toFinitePositiveInt(-1)).toBeNull();
  });

  it("parses positive strings", () => {
    expect(toFinitePositiveInt("10")).toBe(10);
  });

  it("rejects non-positive strings", () => {
    expect(toFinitePositiveInt("0")).toBeNull();
    expect(toFinitePositiveInt("-5")).toBeNull();
  });
});

describe("toFiniteNonNegativeInt", () => {
  it("accepts zero", () => {
    expect(toFiniteNonNegativeInt(0)).toBe(0);
  });

  it("rounds to nearest int", () => {
    expect(toFiniteNonNegativeInt(3.4)).toBe(3);
    expect(toFiniteNonNegativeInt(3.6)).toBe(4);
  });

  it("rejects negative", () => {
    expect(toFiniteNonNegativeInt(-0.1)).toBeNull();
  });
});

describe("normalizeDucats", () => {
  it("rounds finite non-negative values", () => {
    expect(normalizeDucats(15.4)).toBe(15);
    expect(normalizeDucats(15.5)).toBe(16);
    expect(normalizeDucats(0)).toBe(0);
  });

  it("parses numeric strings and boxed numbers", () => {
    expect(normalizeDucats("45.6")).toBe(46);
    expect(normalizeDucats({ $numberInt: "100" })).toBe(100);
  });

  it("rejects negative and non-finite values", () => {
    expect(normalizeDucats(-1)).toBeNull();
    expect(normalizeDucats(NaN)).toBeNull();
    expect(normalizeDucats("ducats")).toBeNull();
    expect(normalizeDucats(null)).toBeNull();
  });
});

describe("isRankedGroup", () => {
  it("returns true for mods and arcanes", () => {
    expect(isRankedGroup("mods")).toBe(true);
    expect(isRankedGroup("arcanes")).toBe(true);
  });

  it("returns false for other groups", () => {
    expect(isRankedGroup("relics")).toBe(false);
    expect(isRankedGroup("all_parts")).toBe(false);
    expect(isRankedGroup("full_sets")).toBe(false);
    expect(isRankedGroup("misc")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isRankedGroup(null)).toBe(false);
    expect(isRankedGroup(undefined)).toBe(false);
  });
});

describe("constants", () => {
  it("MAX_SUPPORTED_RANK is 20", () => {
    expect(MAX_SUPPORTED_RANK).toBe(20);
  });

  it("RANKED_GROUPS is frozen", () => {
    expect(Object.isFrozen(RANKED_GROUPS)).toBe(true);
    expect(RANKED_GROUPS).toEqual(["mods", "arcanes"]);
  });
});
