import { describe, expect, it } from "vitest";

import { parseFoundry, parseInventory, parseResources } from "./inventory.js";
import { buildFullSetItems } from "./inventory/fullSets.js";
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
      "/Lotus/Types/Recipes/Weapons/AcceltraPrimeBlueprint": {
        name: "Acceltra Prime Blueprint",
        category: "Resource",
        type: "Blueprint",
        tradable: true,
      },
      "/Lotus/Types/Recipes/Weapons/WeaponParts/AcceltraPrimeBarrel": {
        name: "Acceltra Prime Barrel",
        category: "Resource",
        type: "Prime Part",
        tradable: true,
      },
      "/Lotus/Types/Recipes/WarframeRecipes/AtlasNeuropticsBlueprint": {
        name: "Atlas Neuroptics",
        category: "Resource",
        tradable: false,
      },
      "/Lotus/Types/Recipes/Weapons/WeaponParts/ArumSpinosaRivet": {
        name: "Arum Spinosa Rivet",
        category: "Resource",
        tradable: true,
      },
      "/Lotus/Types/Items/MiscItems/PhotoboothTileDeepminesCave": {
        name: "Deepmines Cave Scene",
        category: "Resource",
      },
      "/Lotus/Types/Items/ShipFeatureItems/ArsenalFeatureItem": {
        name: "Arsenal",
        category: "Resource",
      },
      "/Lotus/Types/Items/SongItems/OnlyneArsenalSongItem": {
        name: "Arsenal",
        category: "Resource",
      },
    };
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: "/Lotus/Types/Items/OrokinCell", ItemCount: 3 },
        { ItemType: "/Lotus/Types/Items/AlloyPlate", ItemCount: 40_000 },
        { ItemType: "/Lotus/Types/Items/Ferrite", ItemCount: 1_000 },
        { ItemType: "/Lotus/Types/Recipes/Weapons/AcceltraPrimeBlueprint", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Recipes/Weapons/WeaponParts/AcceltraPrimeBarrel", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Recipes/WarframeRecipes/AtlasNeuropticsBlueprint", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Recipes/Weapons/WeaponParts/ArumSpinosaRivet", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Items/MiscItems/PhotoboothTileDeepminesCave", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Items/ShipFeatureItems/ArsenalFeatureItem", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Items/SongItems/OnlyneArsenalSongItem", ItemCount: 1 },
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

  // Regression: warframe parts are owned as ...Blueprint but the set lists them
  // as the crafted ...Component, so a complete set was counted as zero.
  it("counts warframe sets from blueprint ownership despite the component-name split", () => {
    const root = "/Lotus/Powersuits/Mag/MagPrime";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Mag Prime",
        category: "Warframes",
        isPrime: true,
        components: [
          { uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint", itemCount: 1, tradable: true, name: "Blueprint" },
          { uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisComponent", itemCount: 1, tradable: true, name: "Chassis" },
          { uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeSystemsComponent", itemCount: 1, tradable: true, name: "Systems" },
        ],
      },
    };
    const owned = new Map<string, number>([
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint", 1],
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisBlueprint", 4],
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeSystemsBlueprint", 2],
    ]);

    const mag = buildFullSetItems(itemDb, owned).find((s) => s.name === "Mag Prime Set");
    expect(mag?.completeSets).toBe(1);
  });

  // Regression: special non-prime weapons (Ghoulsaw, Orvius) get every component
  // flagged tradable:false by @wfcd, and their parts are owned as ...Blueprint.
  // Real parts under /WeaponParts/ must still count; the non-tradeable main
  // blueprint and build resources must not.
  it("counts non-prime weapon sets from WeaponParts ownership, ignoring resources", () => {
    const root = "/Lotus/Weapons/Tenno/Melee/Glaives/TeshinGlaive/TnTeshinGlaiveWep";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Orvius",
        category: "Melee",
        type: "Melee",
        components: [
          { uniqueName: "/Lotus/Types/Recipes/Weapons/WeaponParts/TeshinGlaiveBlade", itemCount: 2, tradable: false, name: "Blade" },
          { uniqueName: "/Lotus/Types/Recipes/Weapons/WeaponParts/TeshinGlaiveDisc", itemCount: 1, tradable: false, name: "Disc" },
          { uniqueName: "/Lotus/Types/Recipes/Weapons/TeshinGlaiveBlueprint", itemCount: 1, tradable: false, name: "Blueprint" },
          { uniqueName: "/Lotus/Types/Items/MiscItems/OrokinCell", itemCount: 10, tradable: false, name: "Orokin Cell" },
        ],
      },
    };
    // Owns spare parts (no main blueprint), exactly the WFM-sellable set.
    const owned = new Map<string, number>([
      ["/Lotus/Types/Recipes/Weapons/WeaponParts/TeshinGlaiveBlade", 2],
      ["/Lotus/Types/Recipes/Weapons/WeaponParts/TeshinGlaiveDisc", 13],
    ]);

    const orvius = buildFullSetItems(itemDb, owned).find((s) => s.name === "Orvius Set");
    expect(orvius?.completeSets).toBe(1);
    expect(orvius?.components).toHaveLength(2);
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

  it("hides focus upgrades and routes upgrade arcanes correctly", () => {
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
      ),
    ).toBeUndefined();
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

  it("does not infer mod rank from XP when explicit rank is absent", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod": {
        name: "Accelerated Blast",
        category: "Mods",
        fusionLimit: 3,
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
          ItemCount: 1,
          XP: 900,
        },
      ],
    };

    const items = parseInventory(data, db);
    const mod = items.find(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
    );

    expect(mod?.rank).toBe(0);
    expect(mod?.maxRank).toBe(3);
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

  it("keeps separate mod instances for different ranks including rank 0", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod": {
        name: "Accelerated Blast",
        category: "Mods",
      },
    };

    const data: RawInventoryData = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
          ItemCount: 1,
          UpgradeData: { CurrentRank: 0, MaxRank: 3 },
        },
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
          ItemCount: 2,
          UpgradeData: { CurrentRank: 3, MaxRank: 3 },
        },
      ],
    };

    const items = parseInventory(data, db).filter(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
    );

    expect(items).toHaveLength(2);
    expect(items.some((item) => item.rank === 0 && item.maxRank === 3 && item.amount === 1)).toBe(
      true,
    );
    expect(items.some((item) => item.rank === 3 && item.maxRank === 3 && item.amount === 2)).toBe(
      true,
    );
    expect(
      items.every((item) => typeof item.inventoryKey === "string" && item.inventoryKey.length > 0),
    ).toBe(true);
  });

  it("includes RawUpgrades rank-0 rows alongside ranked Upgrades rows", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard": {
        name: "Abundant Mutation",
        category: "Mods",
        fusionLimit: 3,
      },
      "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod": {
        name: "Accelerated Blast",
        category: "Mods",
        fusionLimit: 3,
      },
    };

    const data: RawInventoryData = {
      RawUpgrades: [
        {
          ItemType: "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard",
          ItemCount: 1,
        },
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
          ItemCount: 1,
        },
      ],
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
          UpgradeFingerprint: '{"lvl":3}',
        },
      ],
    };

    const items = parseInventory(data, db).filter((item) => item.category === "mods");

    const abundant = items.find(
      (item) => item.internalName === "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard",
    );
    expect(abundant?.inventoryGroup).toBe("mods");
    expect(abundant?.rank).toBe(0);
    expect(abundant?.maxRank).toBe(3);
    expect(abundant?.amount).toBe(1);

    const accelerated = items.filter(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Shotgun/DualStat/AcceleratedBlastMod",
    );
    expect(accelerated).toHaveLength(2);
    expect(accelerated.some((item) => item.rank === 0 && item.amount === 1)).toBe(true);
    expect(accelerated.some((item) => item.rank === 3 && item.amount === 1)).toBe(true);
  });

  it("keeps RawUpgrades resources out of inventory tabs", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Items/MiscItems/ControlModule": {
        name: "Control Module",
        category: "Resource",
        type: "Control Module Part",
        tradable: false,
      },
      "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard": {
        name: "Abundant Mutation",
        category: "Mod",
        type: "Warframe Mod",
        tradable: true,
        fusionLimit: 3,
      },
    };

    const data: RawInventoryData = {
      RawUpgrades: [
        { ItemType: "/Lotus/Types/Items/MiscItems/ControlModule", ItemCount: 4617 },
        { ItemType: "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard", ItemCount: 1 },
      ],
    };

    const items = parseInventory(data, db);
    const controlModule = items.find(
      (item) => item.internalName === "/Lotus/Types/Items/MiscItems/ControlModule",
    );
    const abundant = items.find(
      (item) => item.internalName === "/Lotus/Powersuits/Infestation/InfestPassiveAugmentCard",
    );

    expect(controlModule).toBeUndefined();
    expect(abundant?.inventoryGroup).toBe("mods");
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

  it("keeps all-parts focused on tradable build components", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Volt/VoltPrime": {
        name: "Volt Prime",
        category: "Warframes",
        type: "Warframe",
        isPrime: true,
        tradable: true,
      },
      "/Lotus/Types/Recipes/Weapons/LatronPrimeBlueprint": {
        name: "Latron Prime Blueprint",
        category: "Primary",
        type: "Blueprint",
        isPrime: true,
        tradable: true,
        isBuildComponent: true,
      },
      "/Lotus/Types/Recipes/Weapons/BurstonPrimeBlueprint": {
        name: "Burston Prime Blueprint",
        category: "Recipe",
        type: "Blueprint",
        isPrime: true,
      },
      "/Lotus/Types/Recipes/WarframeRecipes/XakuPrimeHelmetBlueprint": {
        name: "Xaku Prime Helmet Blueprint",
        category: "Recipe",
        type: "Blueprint",
        isPrime: true,
      },
      "/Lotus/Types/Recipes/Weapons/BratonBlueprint": {
        name: "Braton Blueprint",
        category: "Recipe",
        type: "Blueprint",
        isPrime: false,
      },
      "/Lotus/Types/Items/MiscItems/PhotoboothTileCetusTown": {
        name: "Cetus Scene",
        category: "Resource",
        type: "Captura",
        tradable: true,
      },
      "/Lotus/Types/Items/ShipFeatureItems/ArsenalFeatureItem": {
        name: "Arsenal",
        category: "Resource",
      },
      "/Lotus/Types/Items/MiscItems/ControlModule": {
        name: "Control Module",
        category: "Resource",
        type: "Resource",
        tradable: false,
      },
      "/Lotus/Types/Items/FusionTreasures/OroFusexOrnamentB": {
        name: "Ayatan Amber Star",
        category: "Misc",
        type: "Ayatan Star",
        tradable: true,
      },
    };

    const data: RawInventoryData = {
      Suits: [{ ItemType: "/Lotus/Powersuits/Volt/VoltPrime", ItemCount: 1 }],
      MiscItems: [
        { ItemType: "/Lotus/Types/Recipes/Weapons/LatronPrimeBlueprint", ItemCount: 2 },
        { ItemType: "/Lotus/Types/Items/MiscItems/PhotoboothTileCetusTown", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Items/ShipFeatureItems/ArsenalFeatureItem", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Items/MiscItems/ControlModule", ItemCount: 4617 },
      ],
      Recipes: [
        { ItemType: "/Lotus/Types/Recipes/Weapons/BurstonPrimeBlueprint", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Recipes/WarframeRecipes/XakuPrimeHelmetBlueprint", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Recipes/Weapons/BratonBlueprint", ItemCount: 1 },
      ],
      FusionTreasures: [
        { ItemType: "/Lotus/Types/Items/FusionTreasures/OroFusexOrnamentB", ItemCount: 4 },
      ],
    };

    const items = parseInventory(data, db);
    expect(
      items.find((item) => item.internalName === "/Lotus/Powersuits/Volt/VoltPrime")
        ?.inventoryGroup,
    ).toBe("misc");
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Recipes/Weapons/LatronPrimeBlueprint",
      )?.inventoryGroup,
    ).toBe("all_parts");
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Recipes/Weapons/BurstonPrimeBlueprint",
      )?.inventoryGroup,
    ).toBe("all_parts");
    expect(
      items.find(
        (item) =>
          item.internalName === "/Lotus/Types/Recipes/WarframeRecipes/XakuPrimeHelmetBlueprint",
      )?.inventoryGroup,
    ).toBe("all_parts");
    expect(
      items.find(
        (item) =>
          item.internalName === "/Lotus/Types/Recipes/WarframeRecipes/XakuPrimeHelmetBlueprint",
      )?.name,
    ).toBe("Xaku Prime Neuroptics Blueprint");
    expect(
      items.find((item) => item.internalName === "/Lotus/Types/Recipes/Weapons/BratonBlueprint")
        ?.inventoryGroup,
    ).toBe("misc");
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Items/MiscItems/PhotoboothTileCetusTown",
      ),
    ).toBeUndefined();
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Items/ShipFeatureItems/ArsenalFeatureItem",
      ),
    ).toBeUndefined();
    expect(
      items.find((item) => item.internalName === "/Lotus/Types/Items/MiscItems/ControlModule"),
    ).toBeUndefined();
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Items/FusionTreasures/OroFusexOrnamentB",
      )?.inventoryGroup,
    ).toBe("misc");
  });

  it("treats weapon-part recipe entries as all-parts even without explicit tradable flags", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle": {
        name: "Corufell Handle",
        category: "Recipe",
        isBuildComponent: true,
      },
      "/Lotus/Types/Recipes/WarframeRecipes/BrokenFrameChassisBlueprint": {
        name: "Qorvex Chassis Blueprint",
        category: "Recipe",
        isBuildComponent: true,
      },
    };

    const data: RawInventoryData = {
      Recipes: [
        { ItemType: "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle", ItemCount: 1 },
        {
          ItemType: "/Lotus/Types/Recipes/WarframeRecipes/BrokenFrameChassisBlueprint",
          ItemCount: 1,
        },
      ],
    };

    const items = parseInventory(data, db);
    expect(
      items.find(
        (item) => item.internalName === "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle",
      )?.inventoryGroup,
    ).toBe("all_parts");
    expect(
      items.find(
        (item) =>
          item.internalName === "/Lotus/Types/Recipes/WarframeRecipes/BrokenFrameChassisBlueprint",
      )?.inventoryGroup,
    ).toBe("misc");
  });

  it("keeps non-relic keys out of relic grouping", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Keys/DojoKey": { name: "Dojo Key", category: "Key" },
      "/Lotus/Types/Keys/TestKeyErisBoss": {
        name: "Jordas Golem Assassination",
        category: "Key",
      },
      "/Lotus/Types/Game/Projections/T2VoidProjectionXakuPrimeDBronze": {
        name: "T2Void Projection Xaku Prime D Bronze",
        category: "Relics",
        type: "Relic",
        tradable: true,
      },
    };

    const data: RawInventoryData = {
      LevelKeys: [
        { ItemType: "/Lotus/Types/Keys/DojoKey", ItemCount: 1 },
        { ItemType: "/Lotus/Types/Keys/TestKeyErisBoss", ItemCount: 1 },
      ],
      MiscItems: [
        {
          ItemType: "/Lotus/Types/Game/Projections/T2VoidProjectionXakuPrimeDBronze",
          ItemCount: 3,
        },
      ],
    };

    const items = parseInventory(data, db);
    expect(items.find((item) => item.internalName === "/Lotus/Types/Keys/DojoKey")).toBeUndefined();
    expect(
      items.find((item) => item.internalName === "/Lotus/Types/Keys/TestKeyErisBoss"),
    ).toBeUndefined();
    expect(
      items.find(
        (item) =>
          item.internalName === "/Lotus/Types/Game/Projections/T2VoidProjectionXakuPrimeDBronze",
      )?.inventoryGroup,
    ).toBe("relics");
  });

  it("ignores noisy auxiliary inventory collections", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Items/MiscItems/Forma": { name: "Forma", category: "Misc" },
      "/Lotus/Types/Boosters/AffinityBooster": {
        name: "Affinity Booster",
        category: "Misc",
        type: "Booster",
      },
    };

    const data: RawInventoryData = {
      MiscItems: [{ ItemType: "/Lotus/Types/Items/MiscItems/Forma", ItemCount: 2 }],
      Boosters: [{ ItemType: "/Lotus/Types/Boosters/AffinityBooster", ItemCount: 1 }],
      FocusUpgrades: [
        { ItemType: "/Lotus/Upgrades/Focus/Tactic/Residual/MeleeXpFocusUpgrade", Level: 3 },
      ],
      QuestKeys: [{ ItemType: "/Lotus/Types/Keys/VorsPrize/VorsPrizeQuestKeyChain", ItemCount: 1 }],
      KubrowPets: [
        { ItemType: "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit" },
      ],
    };

    const items = parseInventory(data, db);
    expect(items).toHaveLength(1);
    expect(items[0].internalName).toBe("/Lotus/Types/Items/MiscItems/Forma");
  });
});
