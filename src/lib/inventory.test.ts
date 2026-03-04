import { describe, expect, it } from "vitest";

import { parseFoundry, parseInventory, parseResources } from "./inventory.js";
import type { ItemDbEntry, RawInventoryData, RawInventoryEntry } from "../types/inventory.js";

describe("inventory parsing", () => {
  it("parses inventory categories and hides exalted/special entries", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Player/VoltPrime": {
        name: "Volt Prime",
        isPrime: true,
        masteryReq: 0,
        tradable: true,
      },
      "/Lotus/Types/Weapons/SomaPrime": {
        name: "Soma Prime",
        isPrime: true,
        masteryReq: 7,
        tradable: true,
      },
      "/Lotus/Types/OperatorAmplifiers/AmpOne": {
        name: "Amp One",
        productCategory: "OperatorAmps",
      },
    };

    const data: RawInventoryData = {
      Suits: [{ ItemType: "/Lotus/Types/Player/VoltPrime", XP: 12_000 }],
      LongGuns: [{ ItemType: "/Lotus/Types/Weapons/SomaPrime", XP: 300_000 }],
      OperatorAmps: [{ ItemType: "/Lotus/Types/OperatorAmplifiers/AmpOne", XP: 0 }],
      Melee: [{ ItemType: "/Lotus/Types/ExaltedWeapons/ExaltedBlade", XP: 18_000 }],
    };

    const items = parseInventory(data, db);
    expect(items.length).toBe(3);
    expect(items.some((item) => item.internalName.includes("ExaltedWeapons"))).toBe(false);

    const volt = items.find((item) => item.name === "Volt Prime");
    expect(volt?.category).toBe("warframes");
    expect(volt?.rank).toBe(2);

    const soma = items.find((item) => item.name === "Soma Prime");
    expect(soma?.rank).toBe(30);
    expect(soma?.tradable).toBe(true);

    const amp = items.find((item) => item.name === "Amp One");
    expect(amp?.category).toBe("amps");
  });

  it("parses foundry build completion dates and recipe counts", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Recipes/BuildA": { name: "Build A" },
      "/Lotus/Recipes/BuildB": { name: "Build B" },
      "/Lotus/Recipes/RecipeA": { name: "Recipe A" },
      "/Lotus/Recipes/RecipeB": { name: "Recipe B" },
    };
    const data: RawInventoryData = {
      PendingRecipes: [
        {
          ItemType: "/Lotus/Recipes/BuildA",
          CompletionDate: { $date: { $numberLong: "1710000000000" } },
        },
        {
          ItemType: "/Lotus/Recipes/BuildB",
          CompletionDate: "not-a-date",
        },
      ],
      Recipes: [
        { ItemType: "/Lotus/Recipes/RecipeA", ItemCount: 2 },
        { ItemType: "/Lotus/Recipes/RecipeB" },
      ],
    };

    const foundry = parseFoundry(data, db);
    expect(foundry.building).toHaveLength(2);
    expect(foundry.building[0].endDate?.getTime()).toBe(1_710_000_000_000);
    expect(foundry.building[1].endDate).toBeNull();
    expect(foundry.recipes[0].count).toBe(2);
    expect(foundry.recipes[1].count).toBe(1);
  });

  it("parses resources and sorts by count descending", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Items/AlloyPlate": { name: "Alloy Plate" },
      "/Lotus/Types/Items/OrokinCell": { name: "Orokin Cell" },
      "/Lotus/Types/Items/Ferrite": { name: "Ferrite" },
    };
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: "/Lotus/Types/Items/OrokinCell", ItemCount: 3 },
        { ItemType: "/Lotus/Types/Items/AlloyPlate", ItemCount: 40_000 },
        { ItemType: "/Lotus/Types/Items/Ferrite", ItemCount: 1_000 },
      ],
    };

    const resources = parseResources(data, db);
    expect(resources.map((r) => r.name)).toEqual(["Alloy Plate", "Ferrite", "Orokin Cell"]);
  });

  it("classifies relics/mods/arcanes and derives full sets", () => {
    const setUniqueName = "/Lotus/Types/Items/Sets/BratonPrime";
    const barrelUniqueName = "/Lotus/Types/Items/Parts/BratonPrimeBarrel";
    const receiverUniqueName = "/Lotus/Types/Items/Parts/BratonPrimeReceiver";

    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Relics/LithA1Intact": {
        name: "Lith A1 Relic",
        category: "Relics",
      },
      "/Lotus/Upgrades/Mods/HornetStrike": {
        name: "Hornet Strike",
        category: "Mods",
      },
      "/Lotus/Types/Game/Arcanes/ArcaneVelocity": {
        name: "Arcane Velocity",
        category: "Arcanes",
      },
      [setUniqueName]: {
        name: "Braton Prime",
        tradable: true,
        isPrime: true,
        components: [
          { uniqueName: barrelUniqueName, itemCount: 1, tradable: true, name: "Barrel" },
          { uniqueName: receiverUniqueName, itemCount: 2, tradable: true, name: "Receiver" },
        ],
      },
      [barrelUniqueName]: {
        name: "Braton Prime Barrel",
        tradable: true,
        isPrime: true,
      },
      [receiverUniqueName]: {
        name: "Braton Prime Receiver",
        tradable: true,
        isPrime: true,
      },
    };

    const data: RawInventoryData = {
      LevelKeys: [{ ItemType: "/Lotus/Relics/LithA1Intact", ItemCount: 3 }],
      Upgrades: [{ ItemType: "/Lotus/Upgrades/Mods/HornetStrike", ItemCount: 2 }],
      Arcanes: [{ ItemType: "/Lotus/Types/Game/Arcanes/ArcaneVelocity", ItemCount: 1 }],
      MiscItems: [
        { ItemType: barrelUniqueName, ItemCount: 2 },
        { ItemType: receiverUniqueName, ItemCount: 4 },
      ],
    };

    const items = parseInventory(data, db);

    expect(items.find((item) => item.name === "Lith A1 Relic")?.inventoryGroup).toBe("relics");
    expect(items.find((item) => item.name === "Hornet Strike")?.inventoryGroup).toBe("mods");
    expect(items.find((item) => item.name === "Arcane Velocity")?.inventoryGroup).toBe("arcanes");

    const setItem = items.find((item) => item.internalName === `${setUniqueName}#set`);
    expect(setItem?.inventoryGroup).toBe("full_sets");
    expect(setItem?.completeSets).toBe(2);
    expect(setItem?.amount).toBe(2);
  });

  it("parses nested object collections and leveled rank signals", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/HornetStrike": {
        name: "Hornet Strike",
        category: "Mods",
      },
      "/Lotus/Types/Game/Arcanes/ArcaneVelocity": {
        name: "Arcane Velocity",
        category: "Arcanes",
      },
    };

    const data: RawInventoryData = {
      Upgrades: {
        SlotA: {
          ItemType: "/Lotus/Upgrades/Mods/HornetStrike",
          ItemCount: 3,
          UpgradeData: { CurrentRank: 7, MaxRank: 10 },
          EquippedOn: "Kuva Ogris",
        },
      } as unknown as RawInventoryEntry[],
      Arcanes: {
        GroupA: [
          {
            ItemType: "/Lotus/Types/Game/Arcanes/ArcaneVelocity",
            Quantity: 2,
            ArcaneInfo: { CurrentLevel: 4, MaxArcaneRank: 5 },
          },
        ],
      } as unknown as RawInventoryEntry[],
    };

    const items = parseInventory(data, db);
    const mod = items.find((item) => item.internalName === "/Lotus/Upgrades/Mods/HornetStrike");
    const arcane = items.find(
      (item) => item.internalName === "/Lotus/Types/Game/Arcanes/ArcaneVelocity",
    );

    expect(mod?.inventoryGroup).toBe("mods");
    expect(mod?.amount).toBe(3);
    expect(mod?.rank).toBe(7);
    expect(mod?.leveledUp).toBe(true);
    expect(mod?.equipped).toBe(true);
    expect(mod?.equippedIn).toContain("Kuva Ogris");

    expect(arcane?.inventoryGroup).toBe("arcanes");
    expect(arcane?.amount).toBe(2);
    expect(arcane?.rank).toBe(4);
    expect(arcane?.leveledUp).toBe(true);
  });

  it("keeps focus upgrades out of mods and routes upgrade arcanes correctly", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Focus/Tactic/Residual/MeleeXpFocusUpgrade": {
        name: "Affinity Spike",
        category: "Mods",
        type: "Focus Way",
      },
      "/Lotus/Upgrades/CosmeticEnhancers/Defensive/GolemArcaneShieldRegenOnDamage": {
        name: "Arcane Aegis",
        category: "Arcanes",
        type: "Warframe Arcane",
      },
      "/Lotus/Upgrades/Mods/PointStrike": {
        name: "Point Strike",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Focus/Tactic/Residual/MeleeXpFocusUpgrade",
          ItemCount: 1,
        },
        {
          ItemType: "/Lotus/Upgrades/CosmeticEnhancers/Defensive/GolemArcaneShieldRegenOnDamage",
          ItemCount: 2,
        },
        {
          ItemType: "/Lotus/Upgrades/Mods/PointStrike",
          ItemCount: 6,
        },
      ],
    };

    const items = parseInventory(data, db);
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Upgrades/Focus/Tactic/Residual/MeleeXpFocusUpgrade",
      )?.inventoryGroup,
    ).toBe("misc");
    expect(
      items.find(
        (item) =>
          item.internalName ===
          "/Lotus/Upgrades/CosmeticEnhancers/Defensive/GolemArcaneShieldRegenOnDamage",
      )?.inventoryGroup,
    ).toBe("arcanes");
    expect(
      items.find((item) => item.internalName === "/Lotus/Upgrades/Mods/PointStrike")
        ?.inventoryGroup,
    ).toBe("mods");
  });

  it("keeps non-mod upgrade entries out of mods tab", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Abilities/PassiveHealthBoost": {
        name: "Passive Health Boost",
        category: "Misc",
        type: "Ability Upgrade",
      },
      "/Lotus/Upgrades/Mods/PressurePoint": {
        name: "Pressure Point",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Abilities/PassiveHealthBoost",
          ItemCount: 1,
        },
        {
          ItemType: "/Lotus/Upgrades/Mods/PressurePoint",
          ItemCount: 3,
        },
      ],
    };

    const items = parseInventory(data, db);

    expect(
      items.find((item) => item.internalName === "/Lotus/Upgrades/Abilities/PassiveHealthBoost")
        ?.inventoryGroup,
    ).toBe("misc");
    expect(
      items.find((item) => item.internalName === "/Lotus/Upgrades/Mods/PressurePoint")
        ?.inventoryGroup,
    ).toBe("mods");
  });

  it("parses rank values from boxed numeric fields", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/HornetStrike": {
        name: "Hornet Strike",
        category: "Mods",
      },
      "/Lotus/Types/Game/Arcanes/ArcaneVelocity": {
        name: "Arcane Velocity",
        category: "Arcanes",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/HornetStrike",
          ItemCount: 1,
          UpgradeData: {
            CurrentRank: { $numberInt: "7" },
            MaxRank: { $numberLong: "10" },
          },
        },
      ],
      Arcanes: [
        {
          ItemType: "/Lotus/Types/Game/Arcanes/ArcaneVelocity",
          ItemCount: 1,
          ArcaneInfo: {
            CurrentLevel: { $numberInt: "4" },
            MaxArcaneRank: { $numberInt: "5" },
          },
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find((item) => item.internalName === "/Lotus/Upgrades/Mods/HornetStrike");
    const arcane = items.find(
      (item) => item.internalName === "/Lotus/Types/Game/Arcanes/ArcaneVelocity",
    );

    expect(mod?.rank).toBe(7);
    expect(mod?.maxRank).toBe(10);
    expect(mod?.leveledUp).toBe(true);

    expect(arcane?.rank).toBe(4);
    expect(arcane?.maxRank).toBe(5);
    expect(arcane?.leveledUp).toBe(true);
  });

  it("does not treat upgrade fingerprint as leveled rank signal", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/PointStrike": {
        name: "Point Strike",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/PointStrike",
          ItemCount: 1,
          UpgradeFingerprint: 123456789,
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find((item) => item.internalName === "/Lotus/Upgrades/Mods/PointStrike");
    expect(mod?.rank).toBe(0);
    expect(mod?.leveledUp).toBe(false);
  });

  it("parses mod rank from UpgradeFingerprint JSON payload", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Rifle/WeaponToxinDamageMod": {
        name: "Infected Clip",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Rifle/WeaponToxinDamageMod",
          ItemCount: 1,
          UpgradeFingerprint: '{"lvl":5}',
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Rifle/WeaponToxinDamageMod",
    );
    expect(mod?.rank).toBe(5);
    expect(mod?.leveledUp).toBe(true);
  });

  it("does not infer rank from riven challenge fingerprint payload", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare": {
        name: "Pistol Riven Mod",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare",
          ItemCount: 1,
          UpgradeFingerprint:
            '{"challenge":{"Type":"/Lotus/Types/Challenges/RandomizedFinisherKill","Progress":0,"Required":80}}',
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare",
    );
    expect(mod?.rank).toBe(0);
    expect(mod?.leveledUp).toBe(false);
  });

  it("filters noisy equipped context identifiers", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Shotgun/Event/ProjectNightwatch/SobekNightwatchMod": {
        name: "Acid Shells",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/Event/ProjectNightwatch/SobekNightwatchMod",
          ItemCount: 1,
          InstalledOn: {
            Slot: '["v"-5]',
            OwnerName: "6971475838acd0f6b05e406",
          },
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find(
      (item) =>
        item.internalName ===
        "/Lotus/Upgrades/Mods/Shotgun/Event/ProjectNightwatch/SobekNightwatchMod",
    );

    expect(mod?.equippedIn).toBeUndefined();
  });
});
