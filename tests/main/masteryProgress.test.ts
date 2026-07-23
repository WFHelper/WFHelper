import { beforeAll, describe, expect, it } from "vitest";

import * as itemDb from "../../services/itemDatabase";
import * as masteryHelper from "../../services/masteryHelper";

const WEAPON_RANK_XP = 500;
const SUIT_RANK_XP = 1_000;

function weaponXpForRank(rank: number): number {
  return WEAPON_RANK_XP * rank * rank;
}

function suitXpForRank(rank: number): number {
  return SUIT_RANK_XP * rank * rank;
}

describe("mastery progress", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("uses account XP history so forma-reset mastered gear is not in progress", () => {
    const acceltraPrime = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: acceltraPrime, XP: 0 }],
      XPInfo: [{ ItemType: acceltraPrime, XP: weaponXpForRank(30) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === acceltraPrime);

    expect(item?.rank).toBe(0);
    expect(item?.status).toBe("mastered");
    expect(progress.stats.inProgress).toBe(0);
    // Mastery credit stays banked at the historical rank, not the reset one.
    expect(item?.masteryXp).toBe(3_000);
  });

  it("credits partially releveled forma gear at its highest historical rank", () => {
    const acceltraPrime = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: acceltraPrime, XP: weaponXpForRank(10) }],
      XPInfo: [{ ItemType: acceltraPrime, XP: weaponXpForRank(22) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === acceltraPrime);

    expect(item?.rank).toBe(10); // level bar shows the current rank
    expect(item?.status).toBe("progress");
    expect(item?.masteryXp).toBe(2_200); // credit uses the historical rank 22
  });

  it("merges bayonet primary and melee mastery evidence after a Forma reset", () => {
    const vinquibus = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetRifleWeapon";
    const vinquibusMelee = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetMeleeWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      Melee: [{ ItemType: vinquibusMelee, XP: 0 }],
      XPInfo: [{ ItemType: vinquibus, XP: weaponXpForRank(30) }],
    });

    const melee = progress.items.find((entry) => entry.uniqueName === vinquibusMelee);

    expect(melee?.rank).toBe(30);
    expect(melee?.status).toBe("mastered");
  });

  it("only marks unmastered owned gear below its max rank as in progress", () => {
    const acceltraPrime = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: acceltraPrime, XP: weaponXpForRank(1) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === acceltraPrime);

    expect(item?.rank).toBe(1);
    expect(item?.status).toBe("progress");
  });

  it("uses the weapon affinity curve so partially ranked gear stays in progress", () => {
    const sarofangPrime = "/Lotus/Weapons/Tenno/Melee/Axe/PrimeVorunaAxeWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      Melee: [{ ItemType: sarofangPrime, XP: weaponXpForRank(21) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === sarofangPrime);

    expect(item?.rank).toBe(21);
    expect(item?.status).toBe("progress");
  });

  it("treats Coda weapons as rank-40 gear and reads overcap feature rank", () => {
    const codaBubonico =
      "/Lotus/Weapons/Infested/InfestedLich/LongGuns/CodaBubonico/CodaBubonicoCannon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [{ ItemType: codaBubonico, XP: 0, Features: 35 }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === codaBubonico);

    expect(item?.rank).toBe(36);
    expect(item?.maxRank).toBe(40);
    expect(item?.status).toBe("progress");
  });

  it("matches modular pet shells and Plexus aliases so they do not show as missing", () => {
    const progress = masteryHelper.computeMasteryProgress({
      MoaPets: [
        {
          ItemType: "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetAPowerSuit",
          XP: suitXpForRank(30),
        },
        {
          ItemType: "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetPowerSuit",
          XP: suitXpForRank(30),
        },
      ],
      XPInfo: [
        {
          // Plexus accrues suit-rate affinity (200 mastery per rank).
          ItemType: "/Lotus/Types/Game/CrewShip/RailJack/DefaultHarness",
          XP: suitXpForRank(30),
        },
      ],
    });

    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Hound")?.status).toBe("mastered");
    expect(byName.get("Moa")?.status).toBe("mastered");
    expect(byName.get("Plexus")?.status).toBe("mastered");
  });

  it("includes hidden mastery items represented by the Warframe profile", () => {
    const names = new Set(masteryHelper.getAllMasterableItems().map((item) => item.name));

    expect([...names]).toEqual(
      expect.arrayContaining(["Mote Amp", "Plexus", "Venari", "Venari Prime", "Sirocco"]),
    );
  });

  it("computes account mastery XP from gear, nodes, junctions, and intrinsics", () => {
    const excalibur = "/Lotus/Powersuits/Excalibur/Excalibur";
    const progress = masteryHelper.computeMasteryProgress({
      PlayerLevel: 2,
      XPInfo: [{ ItemType: excalibur, XP: suitXpForRank(30) }],
      Missions: [
        // E Prime, masteryExp 24 in ExportRegions
        { Tag: "SolNode27", Completes: 1 },
        // Junctions export masteryExp 0 but grant 1000; Tier 1 = Steel Path grants again
        { Tag: "EarthToVenusJunction", Completes: 2, Tier: 1 },
        { Tag: "SolNode1", Completes: 0 },
      ],
      PlayerSkills: { LPS_GUNNERY: 3, LPP_SPACE: 99_999 },
    });

    const pm = progress.stats.profileMastery;
    // 6000 gear + 24 node + 2000 junction + 4500 intrinsics
    expect(pm?.totalXp).toBe(12_524);
    expect(pm?.rank).toBe(2);
    // MR2 -> MR3 spans 10000..22500
    expect(pm?.xpIntoRank).toBe(2_524);
    expect(pm?.xpForNext).toBe(12_500);
    expect(pm?.percentToNext).toBe(20.2);
    expect(pm?.testReady).toBe(false);
  });

  it("drops the xp bar when the reconstructed total undercounts the game rank", () => {
    // One frame sits far below the MR36 floor: keep the rank, drop the bar.
    const excalibur = "/Lotus/Powersuits/Excalibur/Excalibur";
    const progress = masteryHelper.computeMasteryProgress({
      PlayerLevel: 36,
      XPInfo: [{ ItemType: excalibur, XP: suitXpForRank(30) }],
    });

    const pm = progress.stats.profileMastery;
    expect(pm?.rank).toBe(36);
    expect(pm?.xpIntoRank).toBeNull();
    expect(pm?.xpForNext).toBeNull();
    expect(pm?.percentToNext).toBeNull();
    expect(pm?.testReady).toBe(false);
  });

  it("flags the next mastery test as ready once XP passes the threshold", () => {
    const excalibur = "/Lotus/Powersuits/Excalibur/Excalibur";
    const progress = masteryHelper.computeMasteryProgress({
      PlayerLevel: 0,
      XPInfo: [{ ItemType: excalibur, XP: suitXpForRank(30) }],
    });

    const pm = progress.stats.profileMastery;
    // 6000 gear XP is past the MR1 threshold (2500), so the test is banked
    expect(pm?.totalXp).toBe(6_000);
    expect(pm?.rank).toBe(0);
    expect(pm?.testReady).toBe(true);
    expect(pm?.percentToNext).toBe(100);
  });
});
