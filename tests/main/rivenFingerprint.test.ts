import { describe, expect, it } from "vitest";

import { decodeAllRivens } from "../../services/rivenFingerprint";

const MAX_ROLL_INT = 0x3fffffff;

function rivenInventory(lvl?: number): Record<string, unknown> {
  return {
    Upgrades: [
      {
        ItemType: "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
        ItemId: { $oid: "aaaaaaaaaaaaaaaaaaaaaaa1" },
        UpgradeFingerprint: JSON.stringify({
          compat: "/Lotus/Weapons/Tenno/Rifle/Rifle",
          lim: 0,
          lvlReq: 9,
          lvl,
          rerolls: 2,
          pol: "AP_ATTACK",
          buffs: [{ Tag: "WeaponFireDamageMod", Value: Math.round(MAX_ROLL_INT * 0.72) }],
          curses: [{ Tag: "WeaponFireRateMod", Value: Math.round(MAX_ROLL_INT * 0.3) }],
        }),
      },
    ],
  };
}

describe("decodeAllRivens rank-8 values", () => {
  it("treats an omitted level as unranked without changing the max-rank projection", () => {
    const omitted = decodeAllRivens(rivenInventory()).unveiled[0];
    const unranked = decodeAllRivens(rivenInventory(0)).unveiled[0];
    const maxed = decodeAllRivens(rivenInventory(8)).unveiled[0];

    expect(omitted.currentRank).toBe(0);
    expect(omitted.stats).toEqual(unranked.stats);
    expect(omitted.stats.map((stat) => stat.maxRankValue)).toEqual(
      maxed.stats.map((stat) => stat.displayValue),
    );
    expect(omitted.masteryReq).toBe(9);
    expect(omitted.statPerfectness).toBe(maxed.statPerfectness);
    expect(omitted.overallGrade).toBe(maxed.overallGrade);
    expect(omitted.attributeGrade).toBe(maxed.attributeGrade);
    expect(maxed.currentRank).toBe(8);
  });

  it.each([0, 1, 4, 7, 8])("preserves an explicit rank %i", (rank) => {
    const riven = decodeAllRivens(rivenInventory(rank)).unveiled[0];
    expect(riven.currentRank).toBe(rank);
    expect(riven.maxRank).toBe(8);
  });

  it("decodes listing values at every selectable rank without scaling rounded values", () => {
    const source = decodeAllRivens(rivenInventory(8)).unveiled[0];
    for (let rank = 0; rank <= 8; rank += 1) {
      const atRank = decodeAllRivens(rivenInventory(rank)).unveiled[0];
      expect(source.stats.map((stat) => stat.rankValues?.[rank])).toEqual(
        atRank.stats.map((stat) => stat.displayValue),
      );
      expect(atRank.overallGrade).toBe(source.overallGrade);
      expect(atRank.attributeGrade).toBe(source.attributeGrade);
    }
  });

  it("reports the current-rank value and the rank-8 value side by side", () => {
    const unranked = decodeAllRivens(rivenInventory(0)).unveiled[0];
    const maxed = decodeAllRivens(rivenInventory(8)).unveiled[0];

    expect(unranked).toBeDefined();
    expect(maxed).toBeDefined();

    const buff = unranked.stats.find((stat) => stat.positive);
    const curse = unranked.stats.find((stat) => !stat.positive);
    expect(buff).toBeDefined();
    expect(curse).toBeDefined();

    // An unranked riven shows a ninth of its maxed roll, so the two differ...
    expect(buff?.displayValue).toBeLessThan(buff?.maxRankValue ?? 0);
    // ...and the projection matches what the same roll decodes to at rank 8.
    expect(buff?.maxRankValue).toBe(maxed.stats.find((stat) => stat.positive)?.displayValue);
    expect(curse?.maxRankValue).toBe(maxed.stats.find((stat) => !stat.positive)?.displayValue);
  });

  it("leaves an already-maxed riven's projection equal to its live values", () => {
    const maxed = decodeAllRivens(rivenInventory(8)).unveiled[0];

    for (const stat of maxed.stats) {
      expect(stat.maxRankValue).toBe(stat.displayValue);
    }
  });

  it("keeps a curse negative at rank 8", () => {
    const curse = decodeAllRivens(rivenInventory(0)).unveiled[0].stats.find((s) => !s.positive);

    expect(curse?.displayValue).toBeLessThan(0);
    expect(curse?.maxRankValue).toBeLessThan(0);
  });
});

const CHALLENGES = "/Lotus/Types/Challenges/Seasons/";
const COMPLICATIONS = "/Lotus/Types/Challenges/Complications/";

function veiledInventory(challenges: Record<string, unknown>[]): Record<string, unknown> {
  return {
    Upgrades: challenges.map((challenge) => ({
      ItemType: "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare",
      UpgradeFingerprint: JSON.stringify({ challenge }),
    })),
  };
}

describe("decodeAllRivens veiled challenge groups", () => {
  it("drops the count and complication so the same task shares one group", () => {
    const veiled = decodeAllRivens(
      veiledInventory([
        { Type: `${CHALLENGES}RandomizedHeadshot`, Progress: 3, Required: 40 },
        {
          Type: `${CHALLENGES}DJRandomizedHeadshot`,
          Required: 15,
          Complication: `${COMPLICATIONS}ResetOnDamageTaken`,
        },
        { Type: `${CHALLENGES}RandomizedFisherman`, Required: 8 },
        { Type: `${CHALLENGES}LimitedSynthesis` },
      ]),
    ).veiled;

    expect(veiled.map((entry) => entry.challengeDesc)).toEqual([
      "Kill 40 Enemies with Headshots",
      "Kill 15 Enemies with Headshots without taking damage",
      "Catch 8 fish without missing a throw",
      "Synthesize a Simaris target without using Traps or Abilities while having a Hobbled Dragon Key equipped",
    ]);
    expect(veiled.map((entry) => entry.challengeGroup)).toEqual([
      "Kill Enemies with Headshots",
      "Kill Enemies with Headshots",
      "Catch fish without missing a throw",
      "Synthesize a Simaris target without using Traps or Abilities while having a Hobbled Dragon Key equipped",
    ]);
  });

  it("names an unknown challenge the way its description does", () => {
    const [entry] = decodeAllRivens(
      veiledInventory([{ Type: `${CHALLENGES}RandomizedTameKavats`, Required: 2 }]),
    ).veiled;

    expect(entry.challengeGroup).toBe("Randomized Tame Kavats");
    expect(entry.challengeDesc).toBe("Randomized Tame Kavats");
  });

  it("leaves a riven without a challenge type ungrouped", () => {
    const [entry] = decodeAllRivens(veiledInventory([{ Progress: 0, Required: 5 }])).veiled;

    expect(entry.challengeType).toBeUndefined();
    expect(entry.challengeGroup).toBeUndefined();
  });
});
