import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  correctScannedStats,
  floatToGrade,
  gradeRiven,
  unparseBuff,
  unparseCurse,
} from "../../services/rivenGrading";
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
    expect(floatToGrade(0.5, false)).toBe("B");
  });

  it("respects grade boundaries (matches RivenParser.js exactly)", () => {
    // lerp(-10, 10, rollFloat) = -10 + 20*rollFloat
    expect(floatToGrade(0.975, false)).toBe("S");
    expect(floatToGrade(0.974, false)).toBe("A+");

    expect(floatToGrade(0.875, false)).toBe("A+");
    expect(floatToGrade(0.874, false)).toBe("A");

    expect(floatToGrade(0.775, false)).toBe("A");
    expect(floatToGrade(0.774, false)).toBe("A-");

    expect(floatToGrade(0.675, false)).toBe("A-");
    expect(floatToGrade(0.674, false)).toBe("B+");

    expect(floatToGrade(0.575, false)).toBe("B+");
    expect(floatToGrade(0.574, false)).toBe("B");

    expect(floatToGrade(0.425, false)).toBe("B");
    expect(floatToGrade(0.424, false)).toBe("B-");

    expect(floatToGrade(0.325, false)).toBe("B-");
    expect(floatToGrade(0.324, false)).toBe("C+");

    expect(floatToGrade(0.025, false)).toBe("C-");
    expect(floatToGrade(0.024, false)).toBe("F");
  });

  it("grades curses by absolute magnitude (farther from 0 = higher grade)", () => {
    expect(floatToGrade(1.0, true)).toBe("S");
    expect(floatToGrade(0.0, true)).toBe("F");
    expect(floatToGrade(0.5, true)).toBe("B");
  });
});

describe("unparseBuff", () => {
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
    expect(result).toBeCloseTo(0.95, 1);
  });

  it("handles zero base value with fallback 0.5", () => {
    expect(unparseBuff(50, 0, 1.0, 1, 0)).toBe(0.5);
  });

  it("reports the raw roll for values no card can show", () => {
    expect(unparseBuff(9999, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod")).toBeCloseTo(312.94, 1);
    expect(unparseBuff(0, 0.016666, 0.7, 1, 0, "WeaponCritChanceMod")).toBeCloseTo(-4.5, 10);
  });
});

describe("unparseCurse", () => {
  it("returns a value between 0 and 1 for typical curse values", () => {
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

    it("resolves a Duviri melee name to the Tenno weapon, not the Drifter twin", () => {
      expect(rivenData.getWeaponDisposition("Sampotes")).toBe(1);
      expect(rivenData.getWeaponDisposition("Syam")).toBe(0.75);
      expect(rivenData.getWeaponDisposition("Edun")).toBe(1.15);
      expect(rivenData.getWeaponDisposition("Argo & Vel")).toBe(1.15);
      expect(rivenData.getWeaponDisposition("Sun & Moon")).toBe(0.8);
      expect(rivenData.getWeaponDisposition("Azothane")).toBe(1.1);
    });

    it("lists no Drifter disposition among a Duviri weapon's family variants", () => {
      expect(rivenData.getFamilyVariants("Edun")).toEqual([{ name: "Edun", disposition: 1.15 }]);
    });
  });

  describe("isMeleeWeapon", () => {
    it("returns false for an unknown weapon", () => {
      expect(rivenData.isMeleeWeapon("Nonexistent")).toBe(false);
    });

    it("separates ranged from melee", () => {
      expect(rivenData.isMeleeWeapon("Rubico Prime")).toBe(false);
      expect(rivenData.isMeleeWeapon("Bolto")).toBe(false);
      expect(rivenData.isMeleeWeapon("Skana")).toBe(true);
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

    it("lists a kitgun chamber under its own name only", () => {
      expect(rivenData.getFamilyVariants("Tombfinger")).toEqual([
        { name: "Tombfinger", disposition: 0.85 },
      ]);
      expect(rivenData.getFamilyVariants("Rattleguts")).toEqual([
        { name: "Rattleguts", disposition: 1 },
      ]);
    });

    it("resolves shotguns via holsterCategory (export dropped the SHOTGUN tag)", () => {
      expect(rivenData.resolveRivenType("Boar")).toContain("ShotgunRandomModRare");
      expect(rivenData.resolveRivenType("Tigris Prime")).toContain("ShotgunRandomModRare");
      expect(rivenData.resolveRivenType("Kuva Sobek")).toContain("ShotgunRandomModRare");
    });

    it("resolves shotguns DE only marks through their archetype", () => {
      for (const weapon of [
        "Drakgoon",
        "Kuva Drakgoon",
        "Convectrix",
        "Phage",
        "Bubonico",
        "Coda Bubonico",
        "Steflos",
      ]) {
        expect(rivenData.resolveRivenType(weapon)).toContain("ShotgunRandomModRare");
      }
      expect(rivenData.resolveRivenType("Quanta")).toContain("RifleRandomModRare");
      expect(rivenData.resolveRivenType("Cernos Prime")).toContain("RifleRandomModRare");
    });

    it("grades a shotgun riven the rifle pool called impossible", () => {
      const graded = gradeRiven("Kuva Drakgoon", [
        { name: "Reload Speed", positive: true, value: 78.1 },
        { name: "Multishot", positive: true, value: 181.6 },
        { name: "Status Duration", positive: false, value: 52.3 },
      ]);
      expect(graded).not.toBeNull();
      for (const stat of graded!.stats) {
        expect(stat.rollFloat).toBeGreaterThan(0);
        expect(stat.rollFloat).toBeLessThan(1);
      }
    });

    it("reads zaw strikes as melee though DE exports them as Pistols", () => {
      expect(rivenData.isMeleeWeapon("Sepfahn")).toBe(true);
      expect(rivenData.isMeleeWeapon("Plague Kripath")).toBe(true);
      expect(rivenData.resolveRivenType("Sepfahn")).toContain("ModularMeleeRandomModRare");
      expect(rivenData.isMeleeWeapon("Catchmoon")).toBe(false);
      expect(rivenData.resolveRivenType("Catchmoon")).toContain("ModularPistolRandomModRare");
    });

    it("resolves Duviri melee to the ordinary melee riven", () => {
      expect(rivenData.resolveRivenType("Sun & Moon")).toContain("MeleeWeaponRandomModRare");
      expect(rivenData.resolveRivenType("Edun")).toContain("MeleeWeaponRandomModRare");
      expect(rivenData.isMeleeWeapon("Edun")).toBe(true);
    });

    it("resolves companion weapons by the class they holster as", () => {
      expect(rivenData.resolveRivenType("Verglas")).toContain("RifleRandomModRare");
      expect(rivenData.resolveRivenType("Verglas Prime")).toContain("RifleRandomModRare");
      expect(rivenData.resolveRivenType("Vulklok")).toContain("RifleRandomModRare");
      expect(rivenData.resolveRivenType("Sweeper")).toContain("ShotgunRandomModRare");
      expect(rivenData.resolveRivenType("Deconstructor")).toContain("MeleeWeaponRandomModRare");
      expect(rivenData.resolveRivenType("Burst Laser")).toContain("PistolRandomModRare");
      expect(rivenData.resolveRivenType("Prisma Burst Laser")).toContain("PistolRandomModRare");
    });

    it("does not invent a riven type for weapons that cannot roll one", () => {
      expect(rivenData.resolveRivenType("Artemis Bow")).toBeNull(); // exalted
      expect(rivenData.resolveRivenType("Shadow Claws")).toBeNull(); // exalted
      expect(rivenData.resolveRivenType("Sirocco")).toBeNull(); // operator amp
      expect(rivenData.resolveRivenType("Batoten")).toBeNull(); // hound weapon
    });

    it("treats a melee-holstered companion weapon as melee", () => {
      expect(rivenData.isMeleeWeapon("Deconstructor")).toBe(true);
      expect(rivenData.isMeleeWeapon("Verglas")).toBe(false);
      expect(rivenData.isMeleeWeapon("Skana")).toBe(true);
      expect(rivenData.isMeleeWeapon("Rubico Prime")).toBe(false);
    });

    it("returns null for unknown weapon", () => {
      expect(rivenData.resolveRivenType("Nonexistent")).toBeNull();
    });
  });

  describe("getRivenFamilySlug", () => {
    it("strips a variant affix when the base weapon exists", () => {
      expect(rivenData.getRivenFamilySlug("Boar Prime")).toBe("boar");
      expect(rivenData.getRivenFamilySlug("Rubico Prime")).toBe("rubico");
      expect(rivenData.getRivenFamilySlug("Kuva Karak")).toBe("karak");
      expect(rivenData.getRivenFamilySlug("MK1-Braton")).toBe("braton");
    });

    it("treats Prisma as the prefix it is", () => {
      // warframe.market 400s on prisma_obex: rivens live under the base weapon.
      expect(rivenData.getRivenFamilySlug("Prisma Obex")).toBe("obex");
      expect(rivenData.getRivenFamilySlug("Prisma Grakata")).toBe("grakata");
      expect(rivenData.getRivenFamilySlug("Prisma Gorgon")).toBe("gorgon");
    });

    it("leaves Dex weapons alone", () => {
      // WFM carries dex_nikana as its own riven family, so stripping would 400.
      expect(rivenData.getRivenFamilySlug("Dex Nikana")).toBe("dex_nikana");
    });

    it("keeps the affix when the weapon has no base form", () => {
      // WFM has no "gotva" or "kuva_bramma" family - asking for one 404s the search.
      expect(rivenData.getRivenFamilySlug("Gotva Prime")).toBe("gotva_prime");
      expect(rivenData.getRivenFamilySlug("Kuva Bramma")).toBe("kuva_bramma");
      expect(rivenData.getRivenFamilySlug("Tenet Envoy")).toBe("tenet_envoy");
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

  describe("generateRivenSuffix", () => {
    it("orders buffs by roll value descending (Boar Satidra)", () => {
      const shotgunType = rivenData.resolveRivenType("Boar")!;
      const name = rivenData.generateRivenSuffix(shotgunType, [
        { tag: "WeaponFireRateMod", value: 500_000_000 },
        { tag: "WeaponFireIterationsMod", value: 900_000_000 },
      ]);
      expect(name).toBe("Satidra");
    });

    it("flips the name when the value order flips (Boar Critacan)", () => {
      const shotgunType = rivenData.resolveRivenType("Boar")!;
      const name = rivenData.generateRivenSuffix(shotgunType, [
        { tag: "WeaponFireIterationsMod", value: 500_000_000 },
        { tag: "WeaponCritChanceMod", value: 900_000_000 },
      ]);
      expect(name).toBe("Critacan");
    });

    it("hyphenates only the middle buff on 3-buff rolls", () => {
      const shotgunType = rivenData.resolveRivenType("Boar")!;
      const name = rivenData.generateRivenSuffix(shotgunType, [
        { tag: "WeaponFireIterationsMod", value: 900_000_000 },
        { tag: "WeaponCritChanceMod", value: 600_000_000 },
        { tag: "WeaponFireRateMod", value: 300_000_000 },
      ]);
      expect(name).toBe("Sati-critadra");
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

  it("clamps a roll float no rank or disposition can fit", () => {
    const result = gradeRiven("Rubico Prime", [
      { name: "Critical Chance", positive: true, value: 9999 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.stats[0].rollFloat).toBe(1);
    expect(result!.stats[0].grade).toBe("S");
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
    expect(result!.stats[2].grade).toBeTruthy();
  });

  it("grades a Duviri melee card against the Tenno disposition", () => {
    const result = gradeRiven("Edun", [
      { name: "Melee Damage", positive: true, value: 177.6 },
      { name: "Critical Damage", positive: true, value: 101.3 },
      { name: "Attack Speed", positive: true, value: 56.8 },
      { name: "Impact", positive: false, value: 101.2 },
    ]);
    expect(result).not.toBeNull();
    for (const stat of result!.stats) {
      expect(stat.rollFloat).toBeGreaterThan(0);
      expect(stat.rollFloat).toBeLessThan(1);
    }
    const grades = Object.fromEntries(result!.stats.map((s) => [s.name, s.grade]));
    expect(grades).toEqual({
      "Melee Damage": "B",
      "Critical Damage": "A-",
      "Attack Speed": "C+",
      Impact: "B+",
    });
  });

  it("returns null for an impossible buff/curse shape instead of clamped S grades", () => {
    expect(
      gradeRiven("Kuva Nukor", [
        { name: "Status Chance", positive: true, value: 42.6 },
        { name: "Heat", positive: true, value: 41.2 },
        { name: "Reload Speed", positive: true, value: 23.0 },
        { name: "Zoom", positive: true, value: 29.8 },
      ]),
    ).toBeNull();
  });

  it("grades a mid-range Kuva Nukor riven with nothing clamped", () => {
    const result = gradeRiven("Kuva Nukor", [
      { name: "Status Chance", positive: true, value: 42.6 },
      { name: "Heat", positive: true, value: 41.2 },
      { name: "Reload Speed", positive: true, value: 23.0 },
      { name: "Zoom", positive: false, value: 29.8 },
    ]);
    expect(result).not.toBeNull();
    for (const stat of result!.stats) {
      expect(stat.rollFloat).toBeGreaterThan(0);
      expect(stat.rollFloat).toBeLessThan(1);
    }
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

  it("grades the linked Boar Prime card against its exact disposition", () => {
    const result = gradeRiven("Boar Prime", [
      { name: "Critical Damage", positive: true, value: 109.9 },
      { name: "Damage", positive: true, value: 202.5 },
      { name: "Critical Chance", positive: true, value: 124 },
      { name: "Impact", positive: false, value: 121 },
    ]);

    expect(result?.stats.map((stat) => stat.grade)).toEqual(["B-", "B-", "S", "B"]);
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

describe("kitgun rolls", () => {
  it("grades a chamber roll against the chamber's own disposition", () => {
    expect(rivenData.getWeaponDisposition("Tombfinger")).toBe(0.85);
    const result = gradeRiven("Tombfinger", [
      { name: "Critical Damage", positive: true, value: 66.4 },
      { name: "Multishot", positive: true, value: 86.4 },
      { name: "Critical Chance", positive: true, value: 115.6 },
      { name: "Zoom", positive: false, value: 51.1 },
    ]);
    const grades = Object.fromEntries((result?.stats ?? []).map((s) => [s.name, s.grade]));
    expect(grades).toEqual({
      "Critical Damage": "C",
      Multishot: "C-",
      "Critical Chance": "B-",
      Zoom: "B",
    });
  });
});

describe("correctScannedStats", () => {
  const namiRoll = (middleName: string) => [
    { name: "Additional Combo Count Chance", positive: true, value: 69.3 },
    { name: middleName, positive: true, value: 190.2 },
    { name: "Heat", positive: true, value: 95.8 },
  ];

  it("renames a garbled damage stat to the sibling whose range fits", () => {
    const { stats, corrections } = correctScannedStats("Nami Solo", namiRoll("Damage"));
    expect(corrections).toBe(1);
    expect(stats[1].name).toBe("Melee Damage");
    expect(stats[1].value).toBe(190.2);
  });

  it("renames a misread Critical Damage whose value only fits Melee Damage", () => {
    const { stats, corrections } = correctScannedStats("Nami Solo", namiRoll("Critical Damage"));
    expect(corrections).toBe(1);
    expect(stats[1].name).toBe("Melee Damage");
  });

  it("leaves a correctly parsed roll untouched", () => {
    const roll = namiRoll("Melee Damage");
    const { stats, corrections } = correctScannedStats("Nami Solo", roll);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual(roll.map((s) => s.name));
  });

  it("keeps an uncorrectable out-of-range value as scanned", () => {
    const { stats, corrections } = correctScannedStats("Nami Solo", [
      { name: "Melee Damage", positive: true, value: 1000 },
    ]);
    expect(corrections).toBe(0);
    expect(stats[0].name).toBe("Melee Damage");
    expect(stats[0].value).toBe(1000);
  });

  it("does not rename plausible ranged damage on a rifle", () => {
    const { corrections } = correctScannedStats("Soma", [
      { name: "Critical Chance", positive: true, value: 150 },
      { name: "Damage", positive: true, value: 165 },
    ]);
    expect(corrections).toBe(0);
  });

  it("skips multiplier and valueless stats", () => {
    const { stats, corrections } = correctScannedStats("Soma", [
      { name: "Damage to Grineer", positive: true, value: 1.3, multiplier: true },
      { name: "Damage", positive: true, value: null },
    ]);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual(["Damage to Grineer", "Damage"]);
  });

  const obexBuffs = [
    { name: "Range", positive: true, value: 2.3 },
    { name: "Critical Damage", positive: true, value: 104.6 },
    { name: "Finisher Damage", positive: true, value: 141.8 },
  ];
  const obexCurse = { name: "Impact", positive: false, value: 104 };

  it("keeps a scanned stat name when a dropped curse line explains the misfit", () => {
    const { stats, corrections } = correctScannedStats("Prisma Obex", obexBuffs);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual(["Range", "Critical Damage", "Finisher Damage"]);
  });

  it("leaves the same card untouched once the curse line is scanned", () => {
    const { stats, corrections } = correctScannedStats("Prisma Obex", [...obexBuffs, obexCurse]);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual([
      "Range",
      "Critical Damage",
      "Finisher Damage",
      "Impact",
    ]);
  });

  const paracesisRoll = [
    { name: "Critical Damage", positive: true, value: 47.4 },
    { name: "Heat", positive: true, value: 44.8 },
    { name: "Finisher Damage", positive: true, value: 63 },
  ];

  it("does not rename when more than one stat misfits the detected weapon", () => {
    const { stats, corrections } = correctScannedStats("Pride", paracesisRoll);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual(["Critical Damage", "Heat", "Finisher Damage"]);
  });

  it("accepts that card on the weapon it was actually rolled for", () => {
    const { corrections } = correctScannedStats("Paracesis", paracesisRoll);
    expect(corrections).toBe(0);
  });

  it("returns the scanned names when the whole card is rejected", () => {
    const { stats, corrections } = correctScannedStats("Nami Solo", [
      { name: "Damage", positive: true, value: 4000 },
      { name: "Critical Damage", positive: true, value: 4000 },
      { name: "Heat", positive: true, value: 4000 },
    ]);
    expect(corrections).toBe(0);
    expect(stats.map((s) => s.name)).toEqual(["Damage", "Critical Damage", "Heat"]);
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

describe("x-multiplier faction damage", () => {
  it("grades a real faction roll inside its range, not clamped", () => {
    const result = gradeRiven("Tatsu", [
      { name: "Status Duration", positive: true, value: 111.6 },
      { name: "Damage to Corpus", positive: true, value: 1.51, multiplier: true },
      { name: "Slash", positive: false, value: 58.5 },
    ]);

    const faction = result!.stats.find((s) => s.name === "Damage to Corpus")!;
    expect(faction.rollFloat).toBeGreaterThan(0);
    expect(faction.rollFloat).toBeLessThan(1);
  });

  it("keeps a faction roll ordered - a bigger multiplier grades higher", () => {
    const at = (value: number) =>
      gradeRiven("Proboscis Cernos", [
        { name: "Damage to Infested", positive: true, value, multiplier: true },
        { name: "Projectile Speed", positive: true, value: 77.2 },
      ])!.stats.find((s) => s.name === "Damage to Infested")!.rollFloat;

    expect(at(1.4)).toBeGreaterThan(at(1.36));
  });
});

describe("unranked cards", () => {
  const UNRANKED_WOLF_SLEDGE = [
    { name: "Range", positive: true, value: 0.2 },
    { name: "Critical Damage", positive: true, value: 12.3 },
    { name: "Attack Speed", positive: true, value: 7.3 },
    { name: "Impact", positive: false, value: 12.2 },
  ];
  const UNRANKED_OBEX = [
    { name: "Range", positive: true, value: 0.3 },
    { name: "Electricity", positive: true, value: 11.4 },
    { name: "Status Chance", positive: true, value: 13.2 },
    { name: "Impact", positive: false, value: 12.9 },
  ];
  const UNRANKED_PANTHERA = [
    { name: "Zoom", positive: true, value: 10.1 },
    { name: "Cold", positive: true, value: 16.3 },
    { name: "Status Chance", positive: false, value: 6.6 },
  ];

  it.each([
    ["Wolf Sledge", UNRANKED_WOLF_SLEDGE],
    ["Obex", UNRANKED_OBEX],
    ["Panthera", UNRANKED_PANTHERA],
  ])("grades an unranked %s on its own rank", (weapon, stats) => {
    const result = gradeRiven(weapon, stats);

    expect(result).not.toBeNull();
    expect(result!.stats.some((s) => s.rollFloat > 0 && s.rollFloat < 1)).toBe(true);
    expect(result!.overallGrade).not.toBe("F");
  });

  it("keeps the same grades when the card is scanned at max rank", () => {
    const unranked = gradeRiven("Wolf Sledge", UNRANKED_WOLF_SLEDGE);
    const maxRank = gradeRiven(
      "Wolf Sledge",
      UNRANKED_WOLF_SLEDGE.map((stat) => ({ ...stat, value: stat.value * 9 })),
    );

    expect(maxRank!.stats.map((s) => s.grade)).toEqual(unranked!.stats.map((s) => s.grade));
  });

  it("grades an unranked Verglas, a sentinel weapon, on the rifle pool", () => {
    const result = gradeRiven("Verglas", [
      { name: "Critical Damage", positive: true, value: 16.4 },
      { name: "Damage", positive: true, value: 23.9 },
      { name: "Critical Chance", positive: true, value: 18.5 },
      { name: "Damage to Infested", positive: false, value: 0.95, multiplier: true },
    ]);

    expect(result).not.toBeNull();
    for (const stat of result!.stats) {
      expect(stat.rollFloat).toBeGreaterThan(0);
      expect(stat.rollFloat).toBeLessThan(1);
    }
  });

  it("needs two stats before it will refit a rank", () => {
    const result = gradeRiven("Wolf Sledge", [
      { name: "Critical Damage", positive: true, value: 12.3 },
    ]);

    expect(result!.stats[0].rollFloat).toBe(0);
  });

  it("grades a card whose curse the scan dropped on the rolls it shows", () => {
    const maxRank = UNRANKED_WOLF_SLEDGE.map((stat) => ({ ...stat, value: stat.value * 9 }));
    const buffsOnly = maxRank.filter((stat) => stat.positive);

    const whole = gradeRiven("Wolf Sledge", maxRank)!;
    const dropped = gradeRiven("Wolf Sledge", buffsOnly)!;

    expect(dropped.stats.map((s) => s.grade)).toEqual(
      whole.stats.filter((s) => s.positive).map((s) => s.grade),
    );
  });

  it("leaves a card that cannot fit any rank at the bottom", () => {
    const impossible = UNRANKED_WOLF_SLEDGE.map((stat) => ({ ...stat, value: stat.value * 90 }));

    const result = gradeRiven("Wolf Sledge", impossible);

    expect(result).not.toBeNull();
    expect(result!.stats.every((s) => s.rollFloat === 0 || s.rollFloat === 1)).toBe(true);
  });
});

describe("a stated rank", () => {
  // A rank-0 Boar roll as warframe.market lists it - 228 of the 500 live Boar
  // auctions are unranked, and their values are a ninth of the rank-8 card.
  const RANK_0_BOAR = [
    { name: "Critical Chance", positive: true, value: 17.2 },
    { name: "Multishot", positive: true, value: 22.6 },
    { name: "Ammo Maximum", positive: false, value: 7.2 },
  ];
  const RANK_8_BOAR = RANK_0_BOAR.map((stat) => ({
    ...stat,
    value: Math.round(stat.value * 9 * 10) / 10,
  }));

  it("grades a rank-0 card exactly like its rank-8 twin", () => {
    const stated = gradeRiven("Boar", RANK_0_BOAR, 0)!;
    const maxRank = gradeRiven("Boar", RANK_8_BOAR, 8)!;

    expect(stated.stats.every((s) => s.rollFloat > 0 && s.rollFloat < 1)).toBe(true);
    expect(stated.stats.map((s) => s.grade)).toEqual(maxRank.stats.map((s) => s.grade));
    expect(stated.overallGrade).toBe(maxRank.overallGrade);
  });

  it("falls back to the search when the stated rank leaves every buff clamped", () => {
    const searched = gradeRiven("Boar", RANK_8_BOAR)!;
    const asRank0 = gradeRiven("Boar", RANK_8_BOAR, 0)!;

    expect(asRank0.stats.map((s) => s.grade)).toEqual(searched.stats.map((s) => s.grade));
    expect(asRank0.overallGrade).toBe(searched.overallGrade);
    expect(asRank0.stats.every((s) => s.rollFloat === 0 || s.rollFloat === 1)).toBe(false);
  });

  it("prefers the stated rank over the rank the search would pick", () => {
    const oneStat = RANK_0_BOAR.slice(0, 1);
    const stated = gradeRiven("Boar", oneStat, 0)!;
    const searched = gradeRiven("Boar", oneStat)!;

    expect(stated.stats[0].rollFloat).toBeGreaterThan(0);
    expect(stated.stats[0].rollFloat).toBeLessThan(1);
    expect(searched.stats[0].rollFloat).toBe(0);
  });

  it("still searches the rank for a caller that cannot state one", () => {
    const searched = gradeRiven("Boar", RANK_0_BOAR)!;
    const stated = gradeRiven("Boar", RANK_0_BOAR, 0)!;

    expect(searched.stats.map((s) => s.grade)).toEqual(stated.stats.map((s) => s.grade));
  });

  it("falls back to the search when the rank is impossible", () => {
    const searched = gradeRiven("Boar", RANK_0_BOAR)!;
    const nonsense = gradeRiven("Boar", RANK_0_BOAR, 42)!;

    expect(nonsense.stats.map((s) => s.grade)).toEqual(searched.stats.map((s) => s.grade));
  });
});
