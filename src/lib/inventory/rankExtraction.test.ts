import { describe, expect, it } from "vitest";

import {
  pickNumeric,
  deepFindNumericByKeys,
  hasAnyRankSignal,
  parseFingerprintPayload,
  extractFingerprintRank,
  normalizeRank,
} from "./rankExtraction.js";
import type { RawInventoryEntry, ItemDbEntry } from "../../types/inventory.js";

// ---------------------------------------------------------------------------
// pickNumeric
// ---------------------------------------------------------------------------

describe("pickNumeric", () => {
  it("returns the first matching numeric value", () => {
    const entry = { Rank: 5, Level: 10 } as RawInventoryEntry;
    expect(pickNumeric(entry, ["Rank", "Level"])).toBe(5);
  });

  it("skips missing keys and returns the first found", () => {
    const entry = { Level: 3 } as RawInventoryEntry;
    expect(pickNumeric(entry, ["Rank", "Level"])).toBe(3);
  });

  it("returns null when no key matches", () => {
    const entry = { foo: "bar" } as RawInventoryEntry;
    expect(pickNumeric(entry, ["Rank", "Level"])).toBeNull();
  });

  it("returns null for non-numeric values", () => {
    const entry = { Rank: "not-a-number" } as RawInventoryEntry;
    expect(pickNumeric(entry, ["Rank"])).toBeNull();
  });

  it("returns zero as a valid numeric value", () => {
    const entry = { Rank: 0 } as RawInventoryEntry;
    expect(pickNumeric(entry, ["Rank"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deepFindNumericByKeys
// ---------------------------------------------------------------------------

describe("deepFindNumericByKeys", () => {
  const rankKeys = new Set(["rank", "level"]);

  it("finds a rank key in a flat object", () => {
    expect(deepFindNumericByKeys({ Rank: 7 }, rankKeys)).toBe(7);
  });

  it("normalizes key casing and non-alpha chars", () => {
    expect(deepFindNumericByKeys({ Mod_Rank: 3 }, new Set(["modrank"]))).toBe(3);
  });

  it("finds rank keys nested in objects", () => {
    expect(deepFindNumericByKeys({ inner: { Level: 4 } }, rankKeys)).toBe(4);
  });

  it("finds rank keys nested in arrays", () => {
    expect(deepFindNumericByKeys([{ Rank: 2 }], rankKeys)).toBe(2);
  });

  it("respects maxDepth limit", () => {
    const deep = { a: { b: { c: { Rank: 5 } } } };
    // depth 0 → a, depth 1 → b, depth 2 → c, depth 3 → Rank
    expect(deepFindNumericByKeys(deep, rankKeys, 2)).toBeNull();
    expect(deepFindNumericByKeys(deep, rankKeys, 3)).toBe(5);
  });

  it("returns null for null/undefined input", () => {
    expect(deepFindNumericByKeys(null, rankKeys)).toBeNull();
    expect(deepFindNumericByKeys(undefined, rankKeys)).toBeNull();
  });

  it("returns null when no matching key exists", () => {
    expect(deepFindNumericByKeys({ foo: 42 }, rankKeys)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasAnyRankSignal
// ---------------------------------------------------------------------------

describe("hasAnyRankSignal", () => {
  it("returns true for a positive rank value", () => {
    expect(hasAnyRankSignal({ Rank: 3 })).toBe(true);
  });

  it("returns false for rank=0 (no positive signal)", () => {
    expect(hasAnyRankSignal({ Rank: 0 })).toBe(false);
  });

  it("returns true for nested rank values", () => {
    expect(hasAnyRankSignal({ inner: { Level: 1 } })).toBe(true);
  });

  it("skips fingerprint keys", () => {
    expect(hasAnyRankSignal({ UpgradeFingerprint: '{"lvl":5}' })).toBe(false);
  });

  it("returns true for a positive FusionLevel", () => {
    expect(hasAnyRankSignal({ FusionLevel: 2 })).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasAnyRankSignal(null)).toBe(false);
    expect(hasAnyRankSignal(undefined)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(hasAnyRankSignal("string")).toBe(false);
    expect(hasAnyRankSignal(42)).toBe(false);
  });

  it("traverses arrays", () => {
    expect(hasAnyRankSignal([{ Rank: 0 }, { Level: 5 }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFingerprintPayload
// ---------------------------------------------------------------------------

describe("parseFingerprintPayload", () => {
  it("parses a JSON string into an object", () => {
    expect(parseFingerprintPayload('{"lvl":3}')).toEqual({ lvl: 3 });
  });

  it("handles double-encoded JSON", () => {
    expect(parseFingerprintPayload('"{\\"lvl\\":5}"')).toEqual({ lvl: 5 });
  });

  it("returns the value as-is for non-string input", () => {
    const obj = { lvl: 2 };
    expect(parseFingerprintPayload(obj)).toBe(obj);
  });

  it("returns null for empty string", () => {
    expect(parseFingerprintPayload("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseFingerprintPayload("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseFingerprintPayload("{broken")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseFingerprintPayload(null)).toBeNull();
  });

  it("returns undefined for undefined input (passthrough for non-string)", () => {
    expect(parseFingerprintPayload(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractFingerprintRank
// ---------------------------------------------------------------------------

describe("extractFingerprintRank", () => {
  it("extracts rank from UpgradeFingerprint with lvl key", () => {
    const entry = { UpgradeFingerprint: '{"lvl":7}' } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBe(7);
  });

  it("extracts rank from UpgradeFingerprint with ModRank key", () => {
    const entry = { UpgradeFingerprint: '{"ModRank":3}' } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBe(3);
  });

  it("returns null when no fingerprint is present", () => {
    const entry = { Rank: 5 } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBeNull();
  });

  it("returns null for negative rank in fingerprint", () => {
    const entry = { UpgradeFingerprint: '{"lvl":-1}' } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBeNull();
  });

  it("floors fractional rank values", () => {
    const entry = { UpgradeFingerprint: '{"lvl":3.7}' } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBe(3);
  });

  it("handles upgradeFingerprint (lowercase) key", () => {
    const entry = { upgradeFingerprint: '{"rank":4}' } as RawInventoryEntry;
    expect(extractFingerprintRank(entry)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// normalizeRank
// ---------------------------------------------------------------------------

describe("normalizeRank", () => {
  it("uses explicit Rank from entry", () => {
    const entry = { Rank: 5 } as RawInventoryEntry;
    const result = normalizeRank(entry, "mods", {});
    expect(result).toEqual({ rank: 5, maxRank: 10 });
  });

  it("defaults mods to rank 0 when no rank signal", () => {
    const entry = {} as RawInventoryEntry;
    const result = normalizeRank(entry, "mods", {});
    expect(result).toEqual({ rank: 0, maxRank: 10 });
  });

  it("defaults arcanes to rank 0 when no rank signal", () => {
    const entry = {} as RawInventoryEntry;
    const result = normalizeRank(entry, "arcanes", {});
    expect(result).toEqual({ rank: 0, maxRank: 5 });
  });

  it("falls back to fingerprint rank when no explicit rank", () => {
    const entry = { UpgradeFingerprint: '{"lvl":3}' } as RawInventoryEntry;
    const result = normalizeRank(entry, "mods", {});
    expect(result).toEqual({ rank: 3, maxRank: 10 });
  });

  it("uses maxRank from dbEntry", () => {
    const entry = { Rank: 7 } as RawInventoryEntry;
    const dbEntry: ItemDbEntry = { maxRank: 14 };
    const result = normalizeRank(entry, "mods", dbEntry);
    expect(result).toEqual({ rank: 7, maxRank: 14 });
  });

  it("prefers explicit entry maxRank over dbEntry maxRank", () => {
    const entry = { Rank: 3, MaxRank: 6 } as RawInventoryEntry;
    const dbEntry: ItemDbEntry = { maxRank: 14 };
    const result = normalizeRank(entry, "mods", dbEntry);
    expect(result).toEqual({ rank: 3, maxRank: 6 });
  });

  it("clamps rank to maxRank", () => {
    const entry = { Rank: 15 } as RawInventoryEntry;
    const result = normalizeRank(entry, "mods", {});
    expect(result).toEqual({ rank: 10, maxRank: 10 });
  });

  it("computes rank from XP for non-mod/arcane groups", () => {
    // 6000 XP per rank
    const entry = { XP: 18000 } as RawInventoryEntry;
    const result = normalizeRank(entry, "misc", {});
    expect(result).toEqual({ rank: 3, maxRank: 30 });
  });

  it("returns rank 0 for zero XP equipment", () => {
    const entry = { XP: 0 } as RawInventoryEntry;
    const result = normalizeRank(entry, "misc", {});
    expect(result).toEqual({ rank: 0, maxRank: 30 });
  });

  it("floors fractional rank values", () => {
    const entry = { Rank: 3.9 } as RawInventoryEntry;
    const result = normalizeRank(entry, "mods", {});
    expect(result).toEqual({ rank: 3, maxRank: 10 });
  });
});
