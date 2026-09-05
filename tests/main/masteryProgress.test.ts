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
    expect(item?.masteryXpRemaining).toBe(800);
  });

  it("merges Vinquibus evidence into one mastery item after a Forma reset", () => {
    const vinquibus = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetRifleWeapon";
    const vinquibusMelee = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetMeleeWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      Melee: [{ ItemType: vinquibusMelee, XP: 0 }],
      XPInfo: [{ ItemType: vinquibus, XP: weaponXpForRank(30) }],
    });

    const primary = progress.items.find((entry) => entry.uniqueName === vinquibus);
    const melee = progress.items.find((entry) => entry.uniqueName === vinquibusMelee);

    expect(primary?.status).toBe("mastered");
    expect(primary?.masteryXp).toBe(3_000);
    expect(melee).toBeUndefined();
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
      LongGuns: [{ ItemType: codaBubonico, XP: 0, Features: 35, Polarized: 3 }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === codaBubonico);

    expect(item?.rank).toBe(36);
    expect(item?.maxRank).toBe(40);
    expect(item?.status).toBe("progress");
  });

  it("caps rank-40 mastery at the rank unlocked by polarizations", () => {
    const codaBubonico =
      "/Lotus/Weapons/Infested/InfestedLich/LongGuns/CodaBubonico/CodaBubonicoCannon";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [
        {
          ItemType: codaBubonico,
          XP: weaponXpForRank(36),
          Features: 35,
          Polarized: 1,
        },
      ],
      XPInfo: [{ ItemType: codaBubonico, XP: weaponXpForRank(32) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === codaBubonico);

    expect(item?.rank).toBe(32);
    expect(item?.masteryXp).toBe(3_200);
    expect(item?.masteryXpRemaining).toBe(800);
  });

  it("credits modular pets to their model heads and lists no phantom chassis cards", () => {
    const progress = masteryHelper.computeMasteryProgress({
      MoaPets: [
        {
          ItemType: "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetPowerSuit",
          XP: suitXpForRank(30),
          Features: 8,
          ModularParts: ["/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetHeadLambeo"],
        },
        {
          // Hound builds without ModularParts still credit via the suit-model alias.
          ItemType: "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetAPowerSuit",
          XP: suitXpForRank(30),
          Features: 8,
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

    expect(byName.get("Lambeo Moa")?.status).toBe("mastered");
    expect(byName.get("Dorma Hound")?.status).toBe("mastered");
    expect(byName.get("Plexus")?.status).toBe("mastered");
    expect(byName.has("Moa")).toBe(false);
    expect(byName.has("Hound")).toBe(false);
  });

  it("does not credit ungilded Hounds or Deimos companions", () => {
    const houndHead = "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadC";
    const panzer = "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit";
    const progress = masteryHelper.computeMasteryProgress({
      MoaPets: [
        {
          ItemType: "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetCPowerSuit",
          XP: suitXpForRank(30),
          ModularParts: [houndHead],
        },
      ],
      KubrowPets: [
        {
          ItemType: panzer,
          XP: suitXpForRank(30),
          ModularParts: [
            "/Lotus/Types/Friendly/Pets/CreaturePets/CreaturePetParts/Deimos/InfestedCritterAntigenB",
            "/Lotus/Types/Friendly/Pets/CreaturePets/CreaturePetParts/Deimos/InfestedCritterMutagenA",
          ],
        },
      ],
    });

    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Hec Hound")?.masteryXp).toBe(0);
    expect(byName.get("Panzer Vulpaphyla")?.masteryXp).toBe(0);
  });

  it("scores sold MOA and Hound model heads at companion rate", () => {
    const lambeo = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetHeadLambeo";
    const bhaira = "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadB";
    const progress = masteryHelper.computeMasteryProgress({
      XPInfo: [
        { ItemType: lambeo, XP: suitXpForRank(30) },
        { ItemType: bhaira, XP: suitXpForRank(30) },
      ],
    });

    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Lambeo Moa")?.masteryXp).toBe(6_000);
    expect(byName.get("Bhaira Hound")?.masteryXp).toBe(6_000);
  });

  it("scores sold K-Drives at suit rate so XP history cannot fake mastery", () => {
    const deck =
      "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardCorpusA/HoverboardCorpusADeck";
    const progress = masteryHelper.computeMasteryProgress({
      XPInfo: [{ ItemType: deck, XP: suitXpForRank(22) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === deck);

    expect(item?.rank).toBe(22);
    expect(item?.status).toBe("progress");
  });

  it("assigns suit-rate mastery to missing Archwings and K-Drive decks", () => {
    const progress = masteryHelper.computeMasteryProgress({});
    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Amesha")).toMatchObject({
      status: "missing",
      masteryXpRemaining: 6_000,
    });
    expect(byName.get("Bad Baby")).toMatchObject({
      status: "missing",
      masteryXpRemaining: 6_000,
    });
  });

  it("keeps sold hound weapons at weapon rate despite their /Pets/ path", () => {
    const akaten = "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetMeleeWeaponPS";
    const progress = masteryHelper.computeMasteryProgress({
      XPInfo: [{ ItemType: akaten, XP: weaponXpForRank(30) }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === akaten);

    expect(item?.rank).toBe(30);
    expect(item?.status).toBe("mastered");
    expect(item?.masteryXp).toBe(3_000); // weapon credit, not suit-rate 4200
  });

  it("reports the mastery an owned item still has to give", () => {
    const excalibur = "/Lotus/Powersuits/Excalibur/Excalibur";
    const progress = masteryHelper.computeMasteryProgress({
      Suits: [{ ItemType: excalibur, XP: suitXpForRank(20) }],
    });

    const frame = progress.items.find((entry) => entry.uniqueName === excalibur);
    const unowned = progress.items.find((entry) => entry.status === "missing");

    // 10 ranks left at 200 mastery each; an unowned frame is worth all 30.
    expect(frame?.masteryXpRemaining).toBe(2_000);
    expect(unowned?.masteryXpRemaining).toBeGreaterThan(0);
  });

  it("includes hidden mastery items represented by the Warframe profile", () => {
    const names = new Set(masteryHelper.getAllMasterableItems().map((item) => item.name));

    expect([...names]).toEqual(
      expect.arrayContaining(["Mote Prism", "Plexus", "Venari", "Venari Prime", "Sirocco"]),
    );
    expect(names.has("Mote Amp")).toBe(false);
  });

  it("does not credit an ungilded Mote Amp or duplicate its prism", () => {
    const moteAmp =
      "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/OperatorTrainingAmpWeapon";
    const motePrism =
      "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/SentAmpTrainingBarrel";
    const progress = masteryHelper.computeMasteryProgress({
      OperatorAmps: [
        {
          ItemType: moteAmp,
          XP: weaponXpForRank(28),
          Features: 1,
          ModularParts: [motePrism],
        },
      ],
    });

    const prism = progress.items.find((entry) => entry.uniqueName === motePrism);

    expect(progress.items.some((entry) => entry.name === "Mote Amp")).toBe(false);
    expect(prism?.rank).toBe(0);
    expect(prism?.masteryXp).toBe(0);
  });

  it("credits a gilded Mote Amp once through Mote Prism", () => {
    const moteAmp =
      "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/OperatorTrainingAmpWeapon";
    const motePrism =
      "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/SentAmpTrainingBarrel";
    const progress = masteryHelper.computeMasteryProgress({
      OperatorAmps: [
        {
          ItemType: moteAmp,
          XP: weaponXpForRank(30),
          Features: 9,
          ModularParts: [motePrism],
        },
      ],
    });

    const prism = progress.items.find((entry) => entry.uniqueName === motePrism);

    expect(prism?.status).toBe("mastered");
    expect(prism?.masteryXp).toBe(3_000);
  });

  it("credits Sirocco without requiring gilding", () => {
    const sirocco = "/Lotus/Weapons/Operator/Pistols/DrifterPistol/DrifterPistolPlayerWeapon";
    const progress = masteryHelper.computeMasteryProgress({
      OperatorAmps: [{ ItemType: sirocco, XP: weaponXpForRank(30), Features: 1 }],
    });

    const item = progress.items.find((entry) => entry.uniqueName === sirocco);

    expect(item?.status).toBe("mastered");
    expect(item?.masteryXp).toBe(3_000);
  });

  it("includes both Infested Kitgun chambers and maps their mastery", () => {
    const sporelacer =
      "/Lotus/Weapons/Infested/Pistols/InfKitGun/Barrels/InfBarrelEgg/InfModularBarrelEggPart";
    const vermisplicer =
      "/Lotus/Weapons/Infested/Pistols/InfKitGun/Barrels/InfBarrelBeam/InfModularBarrelBeamPart";
    const progress = masteryHelper.computeMasteryProgress({
      LongGuns: [
        {
          ItemType: "/Lotus/Weapons/SolarisUnited/Primary/LotusModularPrimaryBeam",
          XP: weaponXpForRank(30),
          Features: 8,
          ModularParts: [vermisplicer],
        },
      ],
      XPInfo: [{ ItemType: sporelacer, XP: weaponXpForRank(30) }],
    });

    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Sporelacer")?.masteryXp).toBe(3_000);
    expect(byName.get("Vermisplicer")?.masteryXp).toBe(3_000);
  });

  it("credits both Venari companions at companion rate", () => {
    const venari = "/Lotus/Powersuits/Khora/Kavat/KhoraKavatPowerSuit";
    const venariPrime = "/Lotus/Powersuits/Khora/Kavat/KhoraPrimeKavatPowerSuit";
    const progress = masteryHelper.computeMasteryProgress({
      XPInfo: [
        { ItemType: venari, XP: suitXpForRank(30) },
        { ItemType: venariPrime, XP: suitXpForRank(30) },
      ],
    });

    const byName = new Map(progress.items.map((item) => [item.name, item]));

    expect(byName.get("Venari")?.masteryXp).toBe(6_000);
    expect(byName.get("Venari Prime")?.masteryXp).toBe(6_000);
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

describe("recipes that consume the same ingredient twice", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  const BRONCO_PRIME = "/Lotus/Weapons/Tenno/Pistol/BroncoPrime";
  const AKBRONCO_PRIME = "/Lotus/Weapons/Tenno/Akimbo/PrimeAkimboShotGun";
  const AKBRONCO_BLUEPRINT = "/Lotus/Types/Recipes/Weapons/AkbroncoPrimeBlueprint";
  const AKBRONCO_LINK = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkbroncoPrimeLink";

  // DE lists a doubled ingredient as two rows of one, so checking each row
  // against the same total lets a single copy satisfy both.
  function akbroncoWithOneBronco() {
    const progress = masteryHelper.computeMasteryProgress({
      Pistols: [{ ItemType: BRONCO_PRIME, XP: weaponXpForRank(30) }],
      MiscItems: [{ ItemType: AKBRONCO_LINK, ItemCount: 1 }],
      Recipes: [{ ItemType: AKBRONCO_BLUEPRINT, ItemCount: 1 }],
    });
    return progress.items.find((entry) => entry.uniqueName === AKBRONCO_PRIME);
  }

  it("merges the duplicate rows into one that wants both copies", () => {
    const rows = (akbroncoWithOneBronco()?.components || []).filter(
      (comp) => comp.uniqueName === BRONCO_PRIME,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemCount).toBe(2);
  });

  it("does not let one built copy satisfy both halves of the recipe", () => {
    const row = (akbroncoWithOneBronco()?.components || []).find(
      (comp) => comp.uniqueName === BRONCO_PRIME,
    );

    expect(row?.ownedCount).toBe(1);
    expect(row?.owned).toBe(false);
  });

  it("keeps the single-copy ingredients satisfied", () => {
    const components = akbroncoWithOneBronco()?.components || [];
    const link = components.find((comp) => comp.uniqueName === AKBRONCO_LINK);

    expect(link?.itemCount).toBe(1);
    expect(link?.owned).toBe(true);
  });
});
