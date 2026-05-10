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
          ItemType: "/Lotus/Types/Game/CrewShip/RailJack/DefaultHarness",
          XP: weaponXpForRank(30),
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
});
