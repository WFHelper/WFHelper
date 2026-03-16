import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock logger before importing rivenGrading (which imports logger via rivenData)
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Use real warframe-public-export-plus data for realistic tests.

import { floatToGrade, unparseBuff, unparseCurse, gradeRiven } from "../../services/rivenGrading";
import * as rivenData from "../../services/rivenData";

// ── floatToGrade ──────────────────────────────────────────────────────────────

describe("floatToGrade", () => {
  it("returns S for perfect roll (1.0)", () => {
    expect(floatToGrade(1.0, false)).toBe("S");
  });

  it("returns F for worst roll (0.0)", () => {
    expect(floatToGrade(0.0, false)).toBe("F");
  });

  it("returns B for mid-roll (0.5)", () => {
    // lerp(-10, 10, 0.5) = 0 → B (threshold -0.5)
    expect(floatToGrade(0.5, false)).toBe("B");
  });

  it("respects grade boundaries", () => {
    // lerp(-10, 10, rollFloat) = -10 + 20*rollFloat
    // score >= 9.5 → S: rollFloat >= (9.5 + 10) / 20 = 0.975
    expect(floatToGrade(0.975, false)).toBe("S");
    expect(floatToGrade(0.974, false)).toBe("A+");

    // score >= 7.5 → A+: rollFloat >= 17.5/20 = 0.875
    expect(floatToGrade(0.875, false)).toBe("A+");
    expect(floatToGrade(0.874, false)).toBe("A");

    // score >= 5.5 → A: rollFloat >= 15.5/20 = 0.775
    expect(floatToGrade(0.775, false)).toBe("A");
    expect(floatToGrade(0.774, false)).toBe("A-");

    // score >= -8.5 → C-: rollFloat >= 1.5/20 = 0.075
    expect(floatToGrade(0.075, false)).toBe("C-");
    expect(floatToGrade(0.074, false)).toBe("F");
  });

  it("inverts for curses (low value = good curse)", () => {
    // For curses, rollFloat 1.0 means full-strength curse → grade S uses (1 - 1.0) = 0.0 → F
    expect(floatToGrade(1.0, true)).toBe("F");
    // rollFloat 0.0 for curse → (1 - 0.0) = 1.0 → S
    expect(floatToGrade(0.0, true)).toBe("S");
    // rollFloat 0.5 for curse → (1 - 0.5) = 0.5 → B
    expect(floatToGrade(0.5, true)).toBe("B");
  });
});

// ── unparseBuff ───────────────────────────────────────────────────────────────

describe("unparseBuff", () => {
  it("returns ~0.5 for a mid-range value", () => {
    // For a mid-roll: displayed = baseValue * 10 * lerp(0.9, 1.1, 0.5) * disp * buffsAtten * cursesAtten
    // = 0.15 * 10 * 1.0 * 0.6 * 1.0 * 1.0 = 0.9 → 90% displayed
    const result = unparseBuff(90, 0.15, 0.6, 1, 0);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("returns ~1.0 for a max-roll value", () => {
    // Max roll: displayed = 0.15 * 10 * 1.1 * 0.6 * 1.0 * 1.0 = 0.99 → 99%
    const result = unparseBuff(99, 0.15, 0.6, 1, 0);
    expect(result).toBeCloseTo(1.0, 1);
  });

  it("returns ~0.0 for a min-roll value", () => {
    // Min roll: displayed = 0.15 * 10 * 0.9 * 0.6 * 1.0 * 1.0 = 0.81 → 81%
    const result = unparseBuff(81, 0.15, 0.6, 1, 0);
    expect(result).toBeCloseTo(0.0, 1);
  });

  it("accounts for curse attenuation (buffed by having a curse)", () => {
    // 2 buffs + 1 curse: buffsAtten=0.66, cursesAtten=1.0 (index 1 for 1 curse)
    const noCurse = unparseBuff(100, 0.15, 0.6, 2, 0);
    const withCurse = unparseBuff(100, 0.15, 0.6, 2, 1);
    // Having a curse applies cursesAtten[1]=1.0 which doesn't change buff values
    // but the buff attenuation for 2 buffs = 0.66 vs no buffs = 1.0
    expect(noCurse).toBeGreaterThanOrEqual(0);
    expect(withCurse).toBeGreaterThanOrEqual(0);
  });

  it("handles zero base value with fallback 0.5", () => {
    expect(unparseBuff(50, 0, 1.0, 1, 0)).toBe(0.5);
  });

  it("clamps result to 0–1 range", () => {
    // Extremely high displayed value → should clamp to 1.0
    expect(unparseBuff(9999, 0.15, 0.6, 1, 0)).toBe(1.0);
    // Extremely low displayed value → should clamp to 0.0
    expect(unparseBuff(0, 0.15, 0.6, 1, 0)).toBe(0.0);
  });
});

// ── unparseCurse ──────────────────────────────────────────────────────────────

describe("unparseCurse", () => {
  it("returns a value between 0 and 1 for typical curse values", () => {
    // Curse with negative display: e.g. -52.3% Zoom
    const result = unparseCurse(-52.3, 0.06, 0.6, 2, 1);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("handles positive input for curse by using absolute values", () => {
    const a = unparseCurse(-50, 0.06, 1.0, 1, 1);
    const b = unparseCurse(50, 0.06, 1.0, 1, 1);
    expect(a).toBeCloseTo(b, 5);
  });

  it("handles zero base value with fallback 0.5", () => {
    expect(unparseCurse(-25, 0, 1.0, 1, 1)).toBe(0.5);
  });
});

// ── rivenData ─────────────────────────────────────────────────────────────────

describe("rivenData", () => {
  describe("getWeaponDisposition", () => {
    it("returns a number for a known weapon", () => {
      const dispo = rivenData.getWeaponDisposition("Rubico Prime");
      expect(dispo).toBeTypeOf("number");
      expect(dispo).toBeGreaterThan(0);
      expect(dispo).toBeLessThan(2);
    });

    it("is case-insensitive", () => {
      const a = rivenData.getWeaponDisposition("Rubico Prime");
      const b = rivenData.getWeaponDisposition("rubico prime");
      expect(a).toBe(b);
    });

    it("returns null for unknown weapon", () => {
      expect(rivenData.getWeaponDisposition("Nonexistent Weapon")).toBeNull();
    });
  });

  describe("getWeaponCategory", () => {
    it("returns category for LongGuns", () => {
      expect(rivenData.getWeaponCategory("Rubico Prime")).toBe("LongGuns");
    });

    it("returns category for Pistols", () => {
      expect(rivenData.getWeaponCategory("Bolto")).toBe("Pistols");
    });

    it("returns category for Melee", () => {
      expect(rivenData.getWeaponCategory("Skana")).toBe("Melee");
    });

    it("returns null for unknown weapon", () => {
      expect(rivenData.getWeaponCategory("Nonexistent")).toBeNull();
    });
  });

  describe("resolveRivenType", () => {
    it("resolves LongGuns to rifle riven", () => {
      const key = rivenData.resolveRivenType("Rubico Prime");
      expect(key).toContain("RifleRandomModRare");
    });

    it("resolves Pistols to pistol riven", () => {
      const key = rivenData.resolveRivenType("Bolto");
      expect(key).toContain("PistolRandomModRare");
    });

    it("resolves Melee to melee riven", () => {
      const key = rivenData.resolveRivenType("Skana");
      expect(key).toContain("MeleeWeaponRandomModRare");
    });

    it("returns null for unknown weapon", () => {
      expect(rivenData.resolveRivenType("Nonexistent")).toBeNull();
    });
  });

  describe("statNameToTag", () => {
    it("maps common stat names to tags", () => {
      expect(rivenData.statNameToTag("Critical Chance")).toBe("WeaponCritChanceMod");
      expect(rivenData.statNameToTag("Multishot")).toBe("WeaponFireIterationsMod");
      expect(rivenData.statNameToTag("Damage")).toBe("WeaponDamageAmountMod");
    });

    it("is case-insensitive", () => {
      expect(rivenData.statNameToTag("critical chance")).toBe("WeaponCritChanceMod");
      expect(rivenData.statNameToTag("CRITICAL CHANCE")).toBe("WeaponCritChanceMod");
    });

    it("handles melee-specific stats", () => {
      expect(rivenData.statNameToTag("Attack Speed")).toBe("WeaponFireRateMod");
      expect(rivenData.statNameToTag("Range")).toBe("WeaponMeleeRangeIncMod");
      expect(rivenData.statNameToTag("Melee Damage")).toBe("WeaponMeleeDamageMod");
    });

    it("returns null for unknown stat name", () => {
      expect(rivenData.statNameToTag("Nonexistent Stat")).toBeNull();
    });
  });

  describe("findUpgradeEntry", () => {
    it("finds an entry by exact tag match", () => {
      const rivenType = rivenData.resolveRivenType("Rubico Prime")!;
      const entry = rivenData.findUpgradeEntry(rivenType, "WeaponCritChanceMod");
      expect(entry).not.toBeNull();
      expect(entry!.tag).toBe("WeaponCritChanceMod");
      expect(entry!.baseValue).toBeTypeOf("number");
      expect(entry!.baseValue).toBeGreaterThan(0);
    });

    it("returns null for missing tag", () => {
      const rivenType = rivenData.resolveRivenType("Rubico Prime")!;
      expect(rivenData.findUpgradeEntry(rivenType, "NonexistentTag")).toBeNull();
    });
  });

  describe("getWeaponWfmSlug", () => {
    it("converts weapon name to slug format", () => {
      expect(rivenData.getWeaponWfmSlug("Rubico Prime")).toBe("rubico_prime");
      expect(rivenData.getWeaponWfmSlug("Arca Plasmor")).toBe("arca_plasmor");
    });

    it("handles special characters", () => {
      expect(rivenData.getWeaponWfmSlug("Dread's Edge")).toBe("dread_s_edge");
    });
  });
});

// ── gradeRiven (end-to-end) ──────────────────────────────────────────────────

describe("gradeRiven", () => {
  it("returns null for empty stats", () => {
    expect(gradeRiven("Rubico Prime", [])).toBeNull();
  });

  it("returns null for unknown weapon", () => {
    expect(
      gradeRiven("Made Up Weapon", [{ name: "Critical Chance", positive: true, value: 100 }]),
    ).toBeNull();
  });

  it("grades a single buff stat", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Chance", positive: true, value: 90 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.stats).toHaveLength(1);
    expect(result!.stats[0].grade).toBeTruthy();
    expect(result!.stats[0].rollFloat).toBeGreaterThanOrEqual(0);
    expect(result!.stats[0].rollFloat).toBeLessThanOrEqual(1);
    expect(result!.overallGrade).toBeTruthy();
  });

  it("grades multiple stats including a curse", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Chance", positive: true, value: 90 },
      { name: "Multishot", positive: true, value: 70 },
      { name: "Zoom", positive: false, value: 30 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.stats).toHaveLength(3);
    expect(result!.stats[2].positive).toBe(false);
    // Curse grade should be present
    expect(result!.stats[2].grade).toBeTruthy();
  });

  it("assigns B grade to unrecognised stat names", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Chance", positive: true, value: 90 },
      { name: "Some Unknown Stat", positive: true, value: 42 },
    ]);
    expect(result).not.toBeNull();
    const unknownStat = result!.stats.find((s) => s.name === "Some Unknown Stat");
    expect(unknownStat).toBeDefined();
    expect(unknownStat!.grade).toBe("B");
    expect(unknownStat!.rollFloat).toBe(0.5);
  });

  it("handles stats with null value (assigns ? grade)", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Chance", positive: true, value: null },
    ]);
    expect(result).not.toBeNull();
    expect(result!.stats[0].grade).toBe("?");
  });

  it("handles x-multiplier format", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Damage", positive: true, value: 1.59, multiplier: true },
    ]);
    expect(result).not.toBeNull();
    expect(result!.stats).toHaveLength(1);
    expect(result!.stats[0].grade).toBeTruthy();
    expect(result!.stats[0].rollFloat).toBeGreaterThanOrEqual(0);
    expect(result!.stats[0].rollFloat).toBeLessThanOrEqual(1);
  });
});

// ── rivenBestAttributes ──────────────────────────────────────────────────────

describe("rivenBestAttributes", () => {
  // Import directly — no mocking needed (pure data)
  let getBestAttributes: typeof import("../../services/rivenBestAttributes").getBestAttributes;

  beforeEach(async () => {
    const mod = await import("../../services/rivenBestAttributes");
    getBestAttributes = mod.getBestAttributes;
  });

  it("returns rifle attributes for LongGuns", () => {
    const attrs = getBestAttributes("LongGuns");
    expect(attrs.positives).toContain("Critical Chance");
    expect(attrs.positives).toContain("Critical Damage");
    expect(attrs.negatives.length).toBeGreaterThan(0);
  });

  it("returns melee attributes for Melee", () => {
    const attrs = getBestAttributes("Melee");
    expect(attrs.positives).toContain("Attack Speed");
    expect(attrs.positives).toContain("Range");
  });

  it("returns shotgun attributes with isShotgun flag", () => {
    const attrs = getBestAttributes("LongGuns", true);
    expect(attrs.positives).toContain("Status Chance");
  });

  it("returns fallback for unknown category", () => {
    const attrs = getBestAttributes("UnknownCategory");
    expect(attrs.positives.length).toBeGreaterThan(0);
    expect(attrs.negatives.length).toBeGreaterThan(0);
  });
});
