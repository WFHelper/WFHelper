import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

// Mock logger before importing rivenGrading (which imports logger via rivenData)
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Use real warframe-public-export-plus data for realistic tests.

import { floatToGrade, unparseBuff, unparseCurse, gradeRiven } from "../../services/rivenGrading";
import { setRivenGoodRollsForTest } from "../../services/rivenBestAttributes";
import * as rivenData from "../../services/rivenData";

beforeAll(() => {
  setRivenGoodRollsForTest({
    lex: {
      goodAttrs: [
        {
          mandatory: ["WeaponCritDamageMod"],
          optional: [
            "WeaponFireIterationsMod",
            "WeaponToxinDamageMod",
            "WeaponDamageAmountMod",
            "WeaponFireRateMod",
            "WeaponCritChanceMod",
            "WeaponPunctureDepthMod",
          ],
        },
      ],
      acceptedBadAttrs: [
        "WeaponZoomFovMod",
        "WeaponRecoilReductionMod",
        "WeaponArmorPiercingDamageMod",
      ],
    },
    galatine: {
      goodAttrs: [
        {
          mandatory: ["WeaponCritDamageMod", "WeaponFireRateMod", "WeaponMeleeRangeIncMod"],
          optional: [],
        },
      ],
      acceptedBadAttrs: [
        "WeaponMeleeComboEfficiencyMod",
        "SlideAttackCritChanceMod",
        "WeaponMeleeFinisherDamageMod",
      ],
    },
    angstrum: {
      goodAttrs: [
        {
          mandatory: ["WeaponCritDamageMod"],
          optional: [
            "WeaponFireIterationsMod",
            "WeaponToxinDamageMod",
            "WeaponDamageAmountMod",
            "WeaponFireRateMod",
            "WeaponCritChanceMod",
          ],
        },
        {
          mandatory: ["WeaponFireIterationsMod", "WeaponDamageAmountMod"],
          optional: ["WeaponStunChanceMod", "WeaponToxinDamageMod"],
        },
      ],
      acceptedBadAttrs: ["WeaponZoomFovMod"],
    },
  });
});

describe("floatToGrade", () => {
  it("returns S for perfect roll (1.0)", () => {
    expect(floatToGrade(1.0, false)).toBe("S");
  });

  it("returns F for worst roll (0.0)", () => {
    expect(floatToGrade(0.0, false)).toBe("F");
  });

  it("returns B for mid-roll (0.5)", () => {
    // lerp(-10, 10, 0.5) = 0 -> B (threshold -0.5)
    expect(floatToGrade(0.5, false)).toBe("B");
  });

  it("respects grade boundaries (matches RivenParser.js exactly)", () => {
    // lerp(-10, 10, rollFloat) = -10 + 20*rollFloat
    // score >= 9.5 -> S: rollFloat >= 19.5/20 = 0.975
    expect(floatToGrade(0.975, false)).toBe("S");
    expect(floatToGrade(0.974, false)).toBe("A+");

    // score >= 7.5 -> A+: rollFloat >= 17.5/20 = 0.875
    expect(floatToGrade(0.875, false)).toBe("A+");
    expect(floatToGrade(0.874, false)).toBe("A");

    // score >= 5.5 -> A: rollFloat >= 15.5/20 = 0.775
    expect(floatToGrade(0.775, false)).toBe("A");
    expect(floatToGrade(0.774, false)).toBe("A-");

    // score >= 3.5 -> A-: rollFloat >= 13.5/20 = 0.675
    expect(floatToGrade(0.675, false)).toBe("A-");
    expect(floatToGrade(0.674, false)).toBe("B+");

    // score >= 1.5 -> B+: rollFloat >= 11.5/20 = 0.575
    expect(floatToGrade(0.575, false)).toBe("B+");
    expect(floatToGrade(0.574, false)).toBe("B");

    // score >= -1.5 -> B: rollFloat >= 8.5/20 = 0.425
    expect(floatToGrade(0.425, false)).toBe("B");
    expect(floatToGrade(0.424, false)).toBe("B-");

    // score >= -3.5 -> B-: rollFloat >= 6.5/20 = 0.325
    expect(floatToGrade(0.325, false)).toBe("B-");
    expect(floatToGrade(0.324, false)).toBe("C+");

    // score >= -9.5 -> C-: rollFloat >= 0.5/20 = 0.025
    expect(floatToGrade(0.025, false)).toBe("C-");
    expect(floatToGrade(0.024, false)).toBe("F");
  });

  it("inverts for curses (low value = good curse)", () => {
    // For curses, rollFloat 1.0 means full-strength curse -> grade S uses (1 - 1.0) = 0.0 -> F
    expect(floatToGrade(1.0, true)).toBe("F");
    // rollFloat 0.0 for curse -> (1 - 0.0) = 1.0 -> S
    expect(floatToGrade(0.0, true)).toBe("S");
    // rollFloat 0.5 for curse -> (1 - 0.5) = 0.5 -> B
    expect(floatToGrade(0.5, true)).toBe("B");
  });
});

describe("unparseBuff", () => {
  // Forward formula reference: displayed% = baseValue * 15 * disp * pow(1.25,numCurses)
  //   * lerp(0.9,1.1,roll) * buffsAtten[numBuffs] * (lvl+1) * 100
  // For baseValue=0.016666, disp=0.7, 1 buff, 0 curses, lvl=8:
  //   scale = 0.016666 * 15 * 0.7 * 1 * 1 * 9 = 1.574937
  //   min (roll=0.0): 1.574937 * 0.9 * 100 = 141.7
  //   mid (roll=0.5): 1.574937 * 1.0 * 100 = 157.5
  //   max (roll=1.0): 1.574937 * 1.1 * 100 = 173.2

  it("returns ~0.5 for a mid-range value", () => {
    const result = unparseBuff(157.5, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod");
    expect(result).toBeCloseTo(0.5, 1);
  });

  it("returns ~1.0 for a max-roll value", () => {
    const result = unparseBuff(173.2, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod");
    expect(result).toBeCloseTo(1.0, 1);
  });

  it("returns ~0.0 for a min-roll value", () => {
    const result = unparseBuff(141.7, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod");
    expect(result).toBeCloseTo(0.0, 1);
  });

  it("accounts for curse attenuation boost (pow(1.25, numCurses))", () => {
    // With 1 curse: pow(1.25, 1) = 1.25 -> buff values are ~25% higher at same roll
    // 3 buffs, 0 curses, mid-roll: 0.016666 * 15 * 0.7 * 1 * 1.0 * 0.5 * 9 * 100 = 78.7
    const noCurse = unparseBuff(78.7, 0.016666, 0.7, 3, 0, "WeaponCritChanceMod");
    // 3 buffs, 1 curse, mid-roll: 0.016666 * 15 * 0.7 * 1.25 * 1.0 * 0.5 * 9 * 100 = 98.4
    const withCurse = unparseBuff(98.4, 0.016666, 0.7, 3, 1, "WeaponCritChanceMod");
    expect(noCurse).toBeCloseTo(0.5, 1);
    expect(withCurse).toBeCloseTo(0.5, 1);
  });

  it("matches RivenParser.js reference (Rubico Prime crit, roll=0.95)", () => {
    // Reference computed from RivenParser.js: displayed=107.3, rollFloat~0.950
    const result = unparseBuff(107.3, 0.016666, 0.7, 3, 1, "WeaponCritChanceMod");
    expect(result).toBeCloseTo(0.950, 1);
  });

  it("handles zero base value with fallback 0.5", () => {
    expect(unparseBuff(50, 0, 1.0, 1, 0)).toBe(0.5);
  });

  it("clamps result to 0-1 range", () => {
    expect(unparseBuff(9999, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod")).toBe(1.0);
    expect(unparseBuff(0, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod")).toBe(0.0);
  });
});

describe("unparseCurse", () => {
  it("returns a value between 0 and 1 for typical curse values", () => {
    // Recoil curse (negative baseValue), 3 buffs + 1 curse
    const result = unparseCurse(49.1, -0.01, 0.7, 3, 1, "WeaponRecoilReductionMod");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("matches RivenParser.js reference (Rubico Prime recoil, roll=0.7)", () => {
    // Reference computed from RivenParser.js: displayed=49.1, rollFloat~0.696
    const result = unparseCurse(49.1, -0.01, 0.7, 3, 1, "WeaponRecoilReductionMod");
    expect(result).toBeCloseTo(0.696, 1);
  });

  it("handles positive and negative input identically (OCR absolute value)", () => {
    const a = unparseCurse(-49.1, -0.01, 0.7, 3, 1, "WeaponRecoilReductionMod");
    const b = unparseCurse(49.1, -0.01, 0.7, 3, 1, "WeaponRecoilReductionMod");
    expect(a).toBeCloseTo(b, 5);
  });

  it("uses swapped attenuation indexing (buffsTable[numCurses] × curseTable[numBuffs])", () => {
    // For 3 buffs 1 curse: cursesInBuffTable = buffsAtten[1]=1, buffsInCurseTable = curseAtten[3]=0.5
    // For 2 buffs 2 curses: cursesInBuffTable = buffsAtten[2]=0.66, buffsInCurseTable = curseAtten[2]=0.33
    // Same displayed value should give different rollFloats
    const a = unparseCurse(30, 0.01, 1.0, 3, 1);
    const b = unparseCurse(30, 0.01, 1.0, 2, 2);
    expect(a).not.toBeCloseTo(b, 2);
  });

  it("handles zero base value with fallback 0.5", () => {
    expect(unparseCurse(-25, 0, 1.0, 1, 1)).toBe(0.5);
  });
});

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

    it("lists family variants with dispositions", () => {
      const variants = rivenData.getFamilyVariants("Boar");
      const names = variants.map((v) => v.name);
      expect(names).toContain("Boar");
      expect(names).toContain("Boar Prime");
      for (const v of variants) expect(v.disposition).toBeGreaterThan(0);
    });

    it("resolves shotguns via holsterCategory (export dropped the SHOTGUN tag)", () => {
      // Current export: no shotgun carries the SHOTGUN compat tag any more and
      // Boar/Sobek/Kohm variants have no tags at all - all fell back to rifle.
      expect(rivenData.resolveRivenType("Boar")).toContain("ShotgunRandomModRare");
      expect(rivenData.resolveRivenType("Tigris Prime")).toContain("ShotgunRandomModRare");
      expect(rivenData.resolveRivenType("Kuva Sobek")).toContain("ShotgunRandomModRare");
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
});

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

  it("grades shotgun stats against shotgun bases (Boar Critacan regression)", () => {
    // Real riven, AlecaFrame grades B / S / A-. Two stacked bugs produced
    // S/F/S: rifle bases (no SHOTGUN tag in export) and base-Boar dispo for
    // values the game rendered at Boar Prime dispo (variant re-fit covers it).
    const result = gradeRiven("Boar", [
      { name: "Multishot", positive: true, value: 199.3 },
      { name: "Critical Chance", positive: true, value: 163.6 },
      { name: "Slash", positive: false, value: 75.9 },
    ]);
    expect(result).not.toBeNull();
    for (const stat of result!.stats) {
      expect(stat.rollFloat).toBeGreaterThan(0);
      expect(stat.rollFloat).toBeLessThan(1);
    }
    const [multi, cc, slash] = result!.stats;
    expect(multi.grade).toBe("B");
    expect(["S", "A+"]).toContain(cc.grade);
    expect(slash.grade).toBe("A-");
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

describe("rivenBestAttributes", () => {
  let getBestAttributes: typeof import("../../services/rivenBestAttributes").getBestAttributes;

  beforeEach(async () => {
    const mod = await import("../../services/rivenBestAttributes");
    getBestAttributes = mod.getBestAttributes;
  });

  it("returns per-weapon attributes from the dataset", () => {
    const attrs = getBestAttributes("Lex");
    expect(attrs).not.toBeNull();
    expect(attrs!.positives).toContain("Critical Damage");
    expect(attrs!.negatives.length).toBeGreaterThan(0);
  });

  it("labels WeaponFireRateMod as Attack Speed when melee=true", () => {
    const attrs = getBestAttributes("Galatine", true);
    expect(attrs).not.toBeNull();
    expect(attrs!.positives).toContain("Attack Speed");
    expect(attrs!.positives).not.toContain("Fire Rate");
  });

  it("uses the sheet-specific Angstrum positives and negatives", () => {
    const attrs = getBestAttributes("Angstrum");
    expect(attrs).not.toBeNull();
    expect(attrs!.positives).toEqual([
      "Critical Damage",
      "Multishot",
      "Damage",
      "Toxin",
      "Fire Rate",
      "Critical Chance",
      "Status Chance",
    ]);
    expect(attrs!.negatives).toEqual(["Zoom"]);
  });

  it("returns null for unknown weapons (no fallback)", () => {
    expect(getBestAttributes("NotAWeaponName")).toBeNull();
  });
});
