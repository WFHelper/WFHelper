import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../../config/shared/foundryPending.js";
import { parseFoundry, parseInventory, parseResources } from "../../../src/lib/inventory.js";
import {
  chainBuildableBlueprints,
  isFoundryRecipeReady,
} from "../../../src/lib/inventory/foundryResources.js";
import { buildFullSetItems, setRootOf } from "../../../src/lib/inventory/fullSets.js";
import { isCountedForValue } from "../../../src/lib/inventory/valueTotals.js";
import { shouldHydrateMetrics } from "../../../src/lib/inventoryMarket.js";
import { gameRefKey } from "../../../src/lib/marketNaming.js";
import type {
  ItemDbEntry,
  RawInventoryData,
  RawInventoryEntry,
} from "../../../src/types/inventory.js";

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
        isBuildComponent: true,
      },
      [receiverUniqueName]: {
        name: "Braton Prime Receiver",
        tradable: true,
        isPrime: true,
        isBuildComponent: true,
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

  // Warframe parts are owned as ...Blueprint but the set lists them as the
  // crafted ...Component, so matching on the set's own names alone counts zero.
  it("counts warframe sets from blueprint ownership despite the component-name split", () => {
    const root = "/Lotus/Powersuits/Mag/MagPrime";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Mag Prime",
        category: "Warframes",
        isPrime: true,
        components: [
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint",
            itemCount: 1,
            tradable: true,
            name: "Blueprint",
          },
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisComponent",
            itemCount: 1,
            tradable: true,
            name: "Chassis",
          },
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeSystemsComponent",
            itemCount: 1,
            tradable: true,
            name: "Systems",
          },
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

  // "Set" is our own word, so only the item half of the label follows the game
  // language. The English name has to survive as the market join key.
  it("localizes the item half of a set name", () => {
    const root = "/Lotus/Powersuits/Mag/MagPrime";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Mag Prime",
        displayName: "매그 프라임",
        category: "Warframes",
        isPrime: true,
        components: [
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint",
            itemCount: 1,
            tradable: true,
            name: "Blueprint",
          },
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisComponent",
            itemCount: 1,
            tradable: true,
            name: "Chassis",
          },
        ],
      },
    };
    const owned = new Map<string, number>([
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint", 1],
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisBlueprint", 1],
    ]);

    const mag = buildFullSetItems(itemDb, owned).find((s) => s.name === "Mag Prime Set");

    expect(mag?.displayName).toBe("매그 프라임 Set");
  });

  // The set marker is minted in one place; the views must strip it with the
  // exported helper rather than a regex of their own.
  it("round-trips the synthesized set key back to its root uniqueName", () => {
    const root = "/Lotus/Powersuits/Mag/MagPrime";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Mag Prime",
        category: "Warframes",
        isPrime: true,
        components: [
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint",
            itemCount: 1,
            tradable: true,
            name: "Blueprint",
          },
          {
            uniqueName: "/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisComponent",
            itemCount: 1,
            tradable: true,
            name: "Chassis",
          },
        ],
      },
    };
    const owned = new Map<string, number>([
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeBlueprint", 1],
      ["/Lotus/Types/Recipes/WarframeRecipes/MagPrimeChassisBlueprint", 1],
    ]);

    const mag = buildFullSetItems(itemDb, owned).find((s) => s.name === "Mag Prime Set");

    expect(mag?.internalName).not.toBe(root);
    expect(setRootOf(mag?.internalName ?? "")).toBe(root);
    expect(setRootOf(root)).toBe(root);
  });

  it("excludes unlisted blueprints and resources from non-prime weapon sets", () => {
    const root = "/Lotus/Weapons/Tenno/LongGuns/TnQuadSniper/TnQuadSniper";
    const barrel = "/Lotus/Types/Recipes/Weapons/WeaponParts/TnQuadSniperRifleBarrel";
    const receiver = "/Lotus/Types/Recipes/Weapons/WeaponParts/TnQuadSniperRifleReceiver";
    const stock = "/Lotus/Types/Recipes/Weapons/WeaponParts/TnQuadSniperRifleStock";
    const blueprint = "/Lotus/Types/Recipes/Weapons/TnQuadSniperRifleBlueprint";
    const resource = "/Lotus/Types/Gameplay/Zariman/Resources/EclipseVoidWraithItem";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Perigale",
        category: "Primary",
        type: "Rifle",
        components: [
          { uniqueName: barrel, itemCount: 1, tradable: false, name: "Barrel" },
          { uniqueName: blueprint, itemCount: 1, tradable: false, name: "Blueprint" },
          { uniqueName: resource, itemCount: 50, tradable: true, name: "Lua Thrax Plasm" },
          { uniqueName: receiver, itemCount: 1, tradable: false, name: "Receiver" },
          { uniqueName: stock, itemCount: 1, tradable: false, name: "Stock" },
        ],
      },
      [barrel]: { name: "Perigale Barrel", isBuildComponent: true },
      [blueprint]: { name: "Perigale Blueprint", isBuildComponent: true, tradable: false },
      [resource]: { name: "Lua Thrax Plasm", isBuildComponent: false, tradable: true },
      [receiver]: { name: "Perigale Receiver", isBuildComponent: true },
      [stock]: { name: "Perigale Stock", isBuildComponent: true },
    };

    const owned = new Map<string, number>([
      [barrel, 1],
      [receiver, 1],
      [stock, 1],
      [blueprint, 1],
      [resource, 50],
    ]);
    const perigale = buildFullSetItems(itemDb, owned).find((set) => set.name === "Perigale Set");

    expect(perigale?.completeSets).toBe(1);
    expect(perigale?.components.map((component) => component.name)).toEqual([
      "Barrel",
      "Receiver",
      "Stock",
    ]);
  });

  it("keeps a market-tradable main blueprint such as Ambassador's", () => {
    const root = "/Lotus/Weapons/Corpus/LongGuns/CrpArSniper/CrpArSniperRifle";
    const barrel = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperBarrel";
    const blueprint = "/Lotus/Types/Recipes/Weapons/CrpArSniperBlueprint";
    const receiver = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperReceiver";
    const stock = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperStock";
    const itemDb: Record<string, ItemDbEntry> = {
      [root]: {
        name: "Ambassador",
        category: "Primary",
        type: "Rifle",
        components: [
          { name: "Barrel", uniqueName: barrel, tradable: false },
          { name: "Blueprint", uniqueName: blueprint, tradable: false },
          { name: "Receiver", uniqueName: receiver, tradable: false },
          { name: "Stock", uniqueName: stock, tradable: false },
        ],
      },
      [barrel]: { name: "Ambassador Barrel", isBuildComponent: true },
      [blueprint]: { name: "Ambassador Blueprint", isBuildComponent: true, tradable: true },
      [receiver]: { name: "Ambassador Receiver", isBuildComponent: true },
      [stock]: { name: "Ambassador Stock", isBuildComponent: true },
    };
    const parts = new Map([
      [barrel, 1],
      [receiver, 1],
      [stock, 1],
    ]);
    const incomplete = buildFullSetItems(itemDb, parts).find(
      (set) => set.name === "Ambassador Set",
    );
    parts.set(blueprint, 1);
    const complete = buildFullSetItems(itemDb, parts).find((set) => set.name === "Ambassador Set");

    expect(incomplete?.inventoryGroup).toBe("incomplete_sets");
    expect(incomplete?.missingParts).toBe(1);
    expect(complete?.inventoryGroup).toBe("full_sets");
    expect(complete?.components).toHaveLength(4);
  });

  it("counts only unranked finished equipment toward a Prisma Shade set", () => {
    const shade = "/Lotus/Types/Sentinels/SentinelPowersuits/PrismaShadePowerSuit";
    const weapon = "/Lotus/Types/Sentinels/SentinelWeapons/PrismaBurstLaserPistol";
    const db: Record<string, ItemDbEntry> = {
      [shade]: {
        name: "Prisma Shade",
        category: "Sentinels",
        type: "Sentinel",
        masterable: true,
      },
      [weapon]: {
        name: "Prisma Burst Laser",
        category: "SentinelWeapons",
        type: "Sentinel Weapon",
        masterable: true,
      },
    };
    const unranked = parseInventory(
      {
        Sentinels: [{ ItemType: shade, XP: 0 }],
        SentinelWeapons: [{ ItemType: weapon, XP: 0 }],
      },
      db,
    );
    const ranked = parseInventory(
      {
        Sentinels: [{ ItemType: shade, XP: 30_000 }],
        SentinelWeapons: [{ ItemType: weapon, XP: 0 }],
      },
      db,
    );

    expect(unranked.find((item) => item.name === "Prisma Shade Set")?.inventoryGroup).toBe(
      "full_sets",
    );
    expect(ranked.find((item) => item.name === "Prisma Shade Set")?.inventoryGroup).toBe(
      "incomplete_sets",
    );
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

  it("sums combinedAmount across leveled and unleveled copies of a mod", () => {
    const bite = "/Lotus/Upgrades/Mods/Bite";
    const db: Record<string, ItemDbEntry> = {
      [bite]: { name: "Bite", category: "Mods" },
    };

    const data: RawInventoryData = {
      Upgrades: [
        { ItemType: bite, ItemCount: 1, UpgradeData: { CurrentRank: 5, MaxRank: 5 } },
        { ItemType: bite, ItemCount: 1 },
      ],
    };

    const items = parseInventory(data, db);
    const rows = items.filter((item) => item.internalName === bite);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.amount).toBe(1);
      expect(row.combinedAmount).toBe(2);
    }
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

  it("flags mods as equipped when a gear config references their ItemId", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod": {
        name: "Serration",
        category: "Mods",
      },
      "/Lotus/Upgrades/Mods/Rifle/WeaponFireRateMod": {
        name: "Speed Trigger",
        category: "Mods",
      },
    };

    const data = {
      Upgrades: [
        {
          ItemType: "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod",
          ItemId: { $oid: "aaa111" },
          UpgradeFingerprint: '{"lvl":5}',
        },
        {
          ItemType: "/Lotus/Upgrades/Mods/Rifle/WeaponFireRateMod",
          ItemId: { $oid: "bbb222" },
          UpgradeFingerprint: '{"lvl":3}',
        },
      ],
      LongGuns: [
        {
          ItemType: "/Lotus/Weapons/Tenno/Rifle/Rifle",
          Configs: [{ Upgrades: ["aaa111", ""] }, { Upgrades: [] }],
        },
      ],
    } as RawInventoryData;

    const items = parseInventory(data, db);
    const equippedMod = items.find(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod",
    );
    const benchedMod = items.find(
      (item) => item.internalName === "/Lotus/Upgrades/Mods/Rifle/WeaponFireRateMod",
    );

    expect(equippedMod?.equipped).toBe(true);
    expect(benchedMod?.equipped).toBeUndefined();
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
    ).toBe("equipment");
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

  it("shows a mission key warframe.market lists", () => {
    const key = "/Lotus/Types/Keys/InfestedAladVQuest/AssassinateInfestedAladVKey";
    const db: Record<string, ItemDbEntry> = {
      [key]: { name: "Mutalist Alad V Assassinate", category: "Quests", type: "Key" },
    };
    const data: RawInventoryData = { LevelKeys: [{ ItemType: key, ItemCount: 8 }] };

    expect(parseInventory(data, db).find((item) => item.internalName === key)).toBeUndefined();

    const listed = parseInventory(data, db, new Set([gameRefKey(key)])).find(
      (item) => item.internalName === key,
    );
    expect(listed).toMatchObject({
      inventoryGroup: "misc",
      categoryLabel: "Key",
      amount: 8,
      tradable: true,
    });
    expect(shouldHydrateMetrics(listed!)).toBe(true);

    // The label follows the key, not the collection it arrived from.
    const fromMisc = parseInventory(
      { MiscItems: [{ ItemType: key, ItemCount: 1 }] },
      db,
      new Set([gameRefKey(key)]),
    ).find((item) => item.internalName === key);
    expect(fromMisc?.categoryLabel).toBe("Key");
  });

  it("marks a crafted frame part untradable once the catalog is loaded", () => {
    const component = "/Lotus/Types/Recipes/WarframeRecipes/AtlasPrimeSystemsComponent";
    const blueprint = "/Lotus/Types/Recipes/WarframeRecipes/AtlasPrimeSystemsBlueprint";
    const barrel = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeBarrel";
    const db: Record<string, ItemDbEntry> = {
      [component]: { name: "Atlas Prime Systems Blueprint", category: "Misc", tradable: true },
      [blueprint]: { name: "Atlas Prime Systems Blueprint", category: "Misc", tradable: true },
      [barrel]: { name: "Braton Prime Barrel", category: "Misc", tradable: true },
    };
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: component, ItemCount: 1 },
        { ItemType: blueprint, ItemCount: 1 },
        { ItemType: barrel, ItemCount: 1 },
      ],
    };

    // WFM trades the blueprint and the bare weapon part, never the crafted part.
    const refs = new Set([gameRefKey(blueprint), gameRefKey(barrel)]);
    const items = parseInventory(data, db, refs);
    expect(items.find((item) => item.internalName === component)?.tradable).toBe(false);
    expect(items.find((item) => item.internalName === blueprint)?.tradable).toBe(true);
    expect(items.find((item) => item.internalName === barrel)?.tradable).toBe(true);

    // The crafted part also leaves the parts tab, or a display-name collision
    // with the blueprint would still price it there.
    expect(items.find((item) => item.internalName === component)?.inventoryGroup).toBe("misc");
    expect(items.find((item) => item.internalName === blueprint)?.inventoryGroup).toBe("all_parts");
    expect(items.find((item) => item.internalName === barrel)?.inventoryGroup).toBe("all_parts");

    // Without the catalog the item-DB flag stands, so nothing flips on startup.
    const fallback = parseInventory(data, db);
    expect(fallback.find((item) => item.internalName === component)?.tradable).toBe(true);
    expect(fallback.find((item) => item.internalName === component)?.inventoryGroup).toBe(
      "all_parts",
    );
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
    };

    const items = parseInventory(data, db);
    expect(items).toHaveLength(1);
    expect(items[0].internalName).toBe("/Lotus/Types/Items/MiscItems/Forma");
  });

  it("does not call a set complete while one part sits in the foundry", () => {
    const RECIPES = "/Lotus/Types/Recipes/WarframeRecipes";
    const PARENT = "/Lotus/Powersuits/Odalisk/ProteaPrime";
    // The set lists parts as ...Component; the inventory holds the ...Blueprint recipes.
    const PARTS = ["Chassis", "Systems", "Neuroptics"];

    const db: Record<string, ItemDbEntry> = {
      [PARENT]: {
        name: "Protea Prime",
        isPrime: true,
        components: [
          {
            uniqueName: `${RECIPES}/ProteaPrimeBlueprint`,
            itemCount: 1,
            tradable: true,
            name: "Blueprint",
          },
          ...PARTS.map((part) => ({
            uniqueName: `${RECIPES}/ProteaPrime${part}Component`,
            itemCount: 1,
            tradable: true,
            name: part,
          })),
        ],
      },
    };
    const data: RawInventoryData = {
      Recipes: [
        { ItemType: `${RECIPES}/ProteaPrimeBlueprint`, ItemCount: 1 },
        ...PARTS.map((part) => ({
          ItemType: `${RECIPES}/ProteaPrime${part}Blueprint`,
          ItemCount: 1,
        })),
      ],
      PendingRecipes: [{ ItemType: `${RECIPES}/ProteaPrimeSystemsBlueprint` }],
    };

    const raw = parseInventory(data, db);
    expect(raw.find((item) => item.inventoryGroup === "full_sets")?.completeSets).toBe(1);

    const usable = parseInventory(withoutFoundryPending(data), db);
    expect(usable.find((item) => item.inventoryGroup === "full_sets")).toBeUndefined();
    const incomplete = usable.find((item) => item.inventoryGroup === "incomplete_sets");
    expect(incomplete?.ownedPartTypes).toBe(3);
    expect(incomplete?.totalPartTypes).toBe(4);
  });
});

const KDRIVE_DECK =
  "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardCorpusA/HoverboardCorpusADeck";
const KDRIVE_JET =
  "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardCorpusA/HoverboardCorpusAJet";
const MOA_HEAD = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetHeadLambeo";
const KITGUN_CHAMBER =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Barrel/SUModularSecondaryBarrelBPart";
const KITGUN_CHAMBER_B =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Barrel/SUModularSecondaryBarrelAPart";
const KITGUN_GRIP =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Clip/SUModularCapIClipPart";
const KITGUN_BASE = "/Lotus/Weapons/SolarisUnited/Secondary/LotusModularSecondary";
const ZAW_TIP = "/Lotus/Weapons/Ostron/Melee/ModularMelee01/Tip/TipOne";
const ZAW_BASE = "/Lotus/Weapons/Ostron/Melee/LotusModularWeapon";
const AMP_PRISM = "/Lotus/Weapons/Sentients/OperatorAmplifiers/Set1/Barrel/SentAmpSet1BarrelPartA";
const AMP_BASE = "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentAmpPreBuiltGun";
const KDRIVE_BASE = "/Lotus/Types/Vehicles/Hoverboard/HoverboardSuit";
const MOA_BASE = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetPowerSuit";
const VULPAPHYLA_BASE =
  "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit";
const VULPAPHYLA_MUTAGEN =
  "/Lotus/Types/Friendly/Pets/CreaturePets/CreaturePetParts/Deimos/InfestedCritterMutagenA";
const PLAIN_KUBROW = "/Lotus/Types/Friendly/Pets/KubrowPets/SunikaKubrowPetPowerSuit";

const MODULAR_DB: Record<string, ItemDbEntry> = {
  [KDRIVE_DECK]: { name: "Ventkid Deck", productCategory: "Pistols" },
  [KDRIVE_JET]: { name: "Ventkid Jet", productCategory: "Pistols" },
  [MOA_HEAD]: { name: "Lambeo Moa", productCategory: "Pistols" },
  [KITGUN_CHAMBER]: {
    name: "Catchmoon",
    productCategory: "Pistols",
    imageUrl: "https://assets.example/catchmoon.png",
  },
  [KITGUN_CHAMBER_B]: { name: "Rattleguts", productCategory: "Pistols" },
  [KITGUN_GRIP]: { name: "Ramble", productCategory: "Pistols" },
  [ZAW_TIP]: { name: "Cyath", productCategory: "Pistols" },
  [AMP_PRISM]: { name: "Raplak Prism", productCategory: "Pistols" },
  [VULPAPHYLA_BASE]: { name: "Panzer Vulpaphyla", productCategory: "KubrowPets" },
  [PLAIN_KUBROW]: { name: "Sunika Kubrow", productCategory: "KubrowPets" },
};

describe("modular part classification", () => {
  it("keeps K-Drive and pet parts in their source bucket despite the Pistols export", () => {
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: KDRIVE_DECK, ItemCount: 1 },
        { ItemType: MOA_HEAD, ItemCount: 1 },
        { ItemType: KITGUN_CHAMBER, ItemCount: 1 },
      ],
    };

    const byName = new Map(
      parseInventory(data, MODULAR_DB).map((item) => [item.internalName, item]),
    );

    for (const uniqueName of [KDRIVE_DECK, MOA_HEAD, KITGUN_CHAMBER]) {
      expect(byName.get(uniqueName)?.category).toBe("misc");
      expect(byName.get(uniqueName)?.categoryLabel).toBe("Misc");
    }
  });

  it("still lets a real secondary weapon claim the Pistols product category", () => {
    const lex = "/Lotus/Weapons/Tenno/Pistols/Lex";
    const items = parseInventory(
      { MiscItems: [{ ItemType: lex, ItemCount: 1 }] },
      { [lex]: { name: "Lex", productCategory: "Pistols" } },
    );

    expect(items[0]?.category).toBe("secondary");
    expect(items[0]?.categoryLabel).toBe("Secondary");
  });
});

describe("built modular equipment", () => {
  it("gives every kitgun build its own row named after the chamber", () => {
    const data: RawInventoryData = {
      Pistols: [
        {
          ItemType: KITGUN_BASE,
          ItemId: { $oid: "aaa" },
          XP: 900_000,
          Features: 8,
          ModularParts: [KITGUN_CHAMBER, KITGUN_GRIP],
        },
        {
          ItemType: KITGUN_BASE,
          ItemId: { $oid: "bbb" },
          XP: 0,
          Features: 8,
          ModularParts: [KITGUN_CHAMBER_B, KITGUN_GRIP],
        },
      ],
    };

    const items = parseInventory(data, MODULAR_DB);
    expect(items).toHaveLength(2);

    const catchmoon = items.find((item) => item.name === "Catchmoon");
    expect(catchmoon?.category).toBe("secondary");
    expect(catchmoon?.categoryLabel).toBe("Kitgun");
    expect(catchmoon?.inventoryGroup).toBe("equipment");
    // The chamber names the build, so its icon stands in for the whole kitgun.
    expect(catchmoon?.imageUrl).toBe("https://assets.example/catchmoon.png");
    expect(catchmoon?.modularParts).toEqual(["Catchmoon", "Ramble"]);
    expect(items.some((item) => item.name === "Rattleguts")).toBe(true);
  });

  it("labels zaws, amps, K-Drives and Moas by their kit", () => {
    const data: RawInventoryData = {
      Melee: [{ ItemType: ZAW_BASE, ItemId: "z1", ModularParts: [ZAW_TIP] }],
      OperatorAmps: [{ ItemType: AMP_BASE, ItemId: "a1", ModularParts: [AMP_PRISM] }],
      Hoverboards: [
        { ItemType: KDRIVE_BASE, ItemId: "k1", ModularParts: [KDRIVE_DECK, KDRIVE_JET] },
      ],
      MoaPets: [{ ItemType: MOA_BASE, ItemId: "m1", ModularParts: [MOA_HEAD] }],
    };

    const byName = new Map(parseInventory(data, MODULAR_DB).map((item) => [item.name, item]));

    expect(byName.get("Cyath")?.categoryLabel).toBe("Zaw");
    expect(byName.get("Cyath")?.category).toBe("melee");
    expect(byName.get("Raplak Prism")?.categoryLabel).toBe("Amp");
    expect(byName.get("Raplak Prism")?.category).toBe("amps");
    expect(byName.get("Ventkid Deck")?.categoryLabel).toBe("K-Drive");
    expect(byName.get("Ventkid Deck")?.modularParts).toEqual(["Ventkid Deck", "Ventkid Jet"]);
    expect(byName.get("Lambeo Moa")?.categoryLabel).toBe("Moa");
    expect(byName.get("Lambeo Moa")?.category).toBe("companions");
    for (const item of byName.values()) {
      expect(item.inventoryGroup).toBe("equipment");
    }
  });

  it("labels a build in the game language of the part that names it", () => {
    const db: Record<string, ItemDbEntry> = {
      ...MODULAR_DB,
      [KITGUN_BASE]: { name: "Kitgun", displayName: "Schussgeraet", productCategory: "Pistols" },
      [KITGUN_CHAMBER]: { ...MODULAR_DB[KITGUN_CHAMBER], displayName: "Fangschuss" },
    };
    const data: RawInventoryData = {
      Pistols: [{ ItemType: KITGUN_BASE, ItemId: "aaa", ModularParts: [KITGUN_CHAMBER] }],
    };

    const kitgun = parseInventory(data, db)[0];
    expect(kitgun.name).toBe("Catchmoon");
    // The base row's "Schussgeraet" would render as the generic weapon.
    expect(kitgun.displayName).toBe("Fangschuss");
  });

  it("drops the base item's localized name when the naming part has none", () => {
    const db: Record<string, ItemDbEntry> = {
      ...MODULAR_DB,
      [KITGUN_BASE]: { name: "Kitgun", displayName: "Schussgeraet", productCategory: "Pistols" },
    };
    const data: RawInventoryData = {
      Pistols: [{ ItemType: KITGUN_BASE, ItemId: "aaa", ModularParts: [KITGUN_CHAMBER] }],
    };

    const kitgun = parseInventory(data, db)[0];
    expect(kitgun.name).toBe("Catchmoon");
    expect(kitgun.displayName).toBeUndefined();
  });

  it("falls back to a generic kit name when no part resolves", () => {
    const data: RawInventoryData = {
      Melee: [{ ItemType: ZAW_BASE, ItemId: "z1", ModularParts: ["/Lotus/Unknown/Tip/Mystery"] }],
    };

    const items = parseInventory(data, {});
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Zaw");
    expect(items[0].categoryLabel).toBe("Zaw");
    expect(items[0].imageUrl).toBeNull();
  });

  it("includes modular Vulpaphylas and plain kubrows become companion rows", () => {
    const data: RawInventoryData = {
      KubrowPets: [
        { ItemType: VULPAPHYLA_BASE, ItemId: "v1", ModularParts: [VULPAPHYLA_MUTAGEN] },
        { ItemType: PLAIN_KUBROW, ItemId: "p1" },
      ],
    };

    const byName = new Map(parseInventory(data, MODULAR_DB).map((item) => [item.name, item]));
    expect([...byName.keys()].sort()).toEqual(["Panzer Vulpaphyla", "Sunika Kubrow"]);
    expect(byName.get("Panzer Vulpaphyla")?.category).toBe("companions");
    expect(byName.get("Sunika Kubrow")?.category).toBe("companions");
  });

  it("keeps a hatched pet in the equipment group and out of trade", () => {
    const data: RawInventoryData = {
      KubrowPets: [{ ItemType: PLAIN_KUBROW, ItemId: "p1" }],
    };

    const pet = parseInventory(data, MODULAR_DB)[0];
    expect(pet.category).toBe("companions");
    expect(pet.categoryLabel).toBe("Companion");
    expect(pet.inventoryGroup).toBe("equipment");
    expect(pet.tradable).toBe(false);
    expect(pet.ducats).toBeNull();
    // A hydrated slug must not drag the pet into the inventory value totals.
    expect(
      isCountedForValue(
        {
          inventoryGroup: pet.inventoryGroup ?? null,
          partType: pet.partType ?? null,
          tradable: pet.tradable,
          amount: pet.amount ?? null,
          marketSlug: "sunika_kubrow",
          platinum: 40,
        },
        "tradable",
      ),
    ).toBe(false);
  });

  it("keeps built modular gear out of the inventory value totals", () => {
    const data: RawInventoryData = {
      Pistols: [{ ItemType: KITGUN_BASE, ItemId: "aaa", ModularParts: [KITGUN_CHAMBER] }],
    };

    const kitgun = parseInventory(data, MODULAR_DB)[0];
    expect(kitgun.tradable).toBe(false);
    expect(kitgun.ducats).toBeNull();
    // A hydrated slug must not drag the row back into the totals.
    expect(
      isCountedForValue(
        {
          inventoryGroup: kitgun.inventoryGroup ?? null,
          partType: kitgun.partType ?? null,
          tradable: kitgun.tradable,
          amount: kitgun.amount ?? null,
          marketSlug: "catchmoon",
          platinum: 40,
        },
        "tradable",
      ),
    ).toBe(false);
  });
});

describe("chainBuildableBlueprints", () => {
  const FRAME = "/wf/Frame";
  const CHASSIS = "/wf/FrameChassis";
  const SYSTEMS = "/wf/FrameSystems";
  const FERRITE = "/misc/Ferrite";
  const CELL = "/misc/Cell";

  const db: Record<string, ItemDbEntry> = {
    [FRAME]: {
      name: "Framey",
      recipe: {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        blueprintUniqueName: "/bp/Frame",
        ingredients: [
          { uniqueName: CHASSIS, count: 1 },
          { uniqueName: SYSTEMS, count: 1 },
          { uniqueName: CELL, count: 3 },
        ],
      },
    } as ItemDbEntry,
    [CHASSIS]: {
      name: "Framey Chassis",
      componentOf: FRAME,
      recipe: {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        blueprintUniqueName: "/bp/Chassis",
        ingredients: [{ uniqueName: FERRITE, count: 2 }],
      },
    } as ItemDbEntry,
    [SYSTEMS]: {
      name: "Framey Systems",
      componentOf: FRAME,
      recipe: {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        blueprintUniqueName: "/bp/Systems",
        ingredients: [{ uniqueName: FERRITE, count: 2 }],
      },
    } as ItemDbEntry,
  };

  function recipeRow(
    uniqueName: string,
    productUniqueName: string,
    ingredients: Array<{ uniqueName: string; count: number }>,
  ) {
    return {
      name: uniqueName,
      imageUrl: null,
      count: 1,
      uniqueName,
      productUniqueName,
      isIngredient: false,
      category: "Warframe",
      ingredients,
      buildPrice: 0,
      buildTime: 0,
    };
  }

  const frameBp = recipeRow("/bp/Frame", FRAME, db[FRAME].recipe!.ingredients);
  const chassisBp = recipeRow("/bp/Chassis", CHASSIS, db[CHASSIS].recipe!.ingredients);
  const systemsBp = recipeRow("/bp/Systems", SYSTEMS, db[SYSTEMS].recipe!.ingredients);

  it("marks a frame whose parts are all craftable from owned blueprints", () => {
    const owned = new Map([
      [FERRITE, 4],
      [CELL, 3],
    ]);
    const result = chainBuildableBlueprints([frameBp, chassisBp, systemsBp], owned, db);

    expect(result.has("/bp/Frame")).toBe(true);
    // Part blueprints stay out: the full-set view hides loose components.
    expect(result.has("/bp/Chassis")).toBe(false);
  });

  it("rejects the frame when a part blueprint is missing", () => {
    const owned = new Map([
      [FERRITE, 4],
      [CELL, 3],
    ]);
    const result = chainBuildableBlueprints([frameBp, chassisBp], owned, db);

    expect(result.has("/bp/Frame")).toBe(false);
  });

  it("rejects the frame when parts would double-spend a shared resource", () => {
    const owned = new Map([
      [FERRITE, 3],
      [CELL, 3],
    ]);
    const result = chainBuildableBlueprints([frameBp, chassisBp, systemsBp], owned, db);

    expect(result.has("/bp/Frame")).toBe(false);
  });

  it("accepts already-built parts without their blueprints", () => {
    const owned = new Map([
      [CHASSIS, 1],
      [SYSTEMS, 1],
      [CELL, 3],
    ]);
    const result = chainBuildableBlueprints([frameBp], owned, db);

    expect(result.has("/bp/Frame")).toBe(true);
  });

  it("scales sub-builds by the recipe yield", () => {
    const PART = "/misc/Part";
    const yieldDb: Record<string, ItemDbEntry> = {
      "/item/Thing": {
        name: "Thing",
        recipe: {
          buildPrice: 0,
          buildTime: 0,
          num: 1,
          blueprintUniqueName: "/bp/Thing",
          ingredients: [{ uniqueName: PART, count: 15 }],
        },
      } as ItemDbEntry,
      [PART]: {
        name: "Part",
        recipe: {
          buildPrice: 0,
          buildTime: 0,
          num: 10,
          blueprintUniqueName: "/bp/Part",
          ingredients: [{ uniqueName: FERRITE, count: 2 }],
        },
      } as ItemDbEntry,
    };
    const thingBp = recipeRow(
      "/bp/Thing",
      "/item/Thing",
      yieldDb["/item/Thing"].recipe!.ingredients,
    );
    // Two builds burn two blueprint copies, so hold the yield math to that.
    const partBp = { ...recipeRow("/bp/Part", PART, yieldDb[PART].recipe!.ingredients), count: 2 };

    // 15 parts = 2 builds of 10, consuming 4 ferrite.
    expect(
      chainBuildableBlueprints([thingBp, partBp], new Map([[FERRITE, 4]]), yieldDb).has(
        "/bp/Thing",
      ),
    ).toBe(true);
    expect(
      chainBuildableBlueprints([thingBp, partBp], new Map([[FERRITE, 3]]), yieldDb).has(
        "/bp/Thing",
      ),
    ).toBe(false);
    // One copy cannot cover both builds.
    expect(
      chainBuildableBlueprints(
        [thingBp, { ...partBp, count: 1 }],
        new Map([[FERRITE, 4]]),
        yieldDb,
      ).has("/bp/Thing"),
    ).toBe(false);
  });
});

// DE names a recipe ingredient ...Component but the inventory only ever holds
// the ...Blueprint it is built from, so the card status and the "Can build
// (full set)" filter have to read the same predicate or they disagree.
describe("foundry set readiness", () => {
  const FRAME = "/Lotus/Powersuits/Test/TestPrime";
  const FRAME_BP = "/Lotus/Types/Recipes/WarframeRecipes/TestPrimeBlueprint";
  const CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
  const RUBEDO = "/Lotus/Types/Items/MiscItems/Rubedo";
  const PARTS = ["Helmet", "Chassis", "Systems"] as const;
  const partComponent = (part: string) =>
    `/Lotus/Types/Recipes/WarframeRecipes/TestPrime${part}Component`;
  const partBlueprint = (part: string) =>
    `/Lotus/Types/Recipes/WarframeRecipes/TestPrime${part}Blueprint`;

  const db: Record<string, ItemDbEntry> = {
    [FRAME]: {
      name: "Test Prime",
      recipe: {
        buildPrice: 25000,
        buildTime: 259200,
        num: 1,
        blueprintUniqueName: FRAME_BP,
        ingredients: [
          ...PARTS.map((part) => ({ uniqueName: partComponent(part), count: 1 })),
          { uniqueName: CELL, count: 3 },
        ],
      },
    } as ItemDbEntry,
  };
  for (const part of PARTS) {
    db[partComponent(part)] = {
      name: `Test Prime ${part}`,
      componentOf: FRAME,
      recipe: {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        blueprintUniqueName: partBlueprint(part),
        ingredients: [{ uniqueName: RUBEDO, count: 100 }],
      },
    } as ItemDbEntry;
  }

  function readiness(inventory: RawInventoryData) {
    const foundry = parseFoundry(inventory, db);
    const owned = aggregateComponentOwnership(inventory.MiscItems, inventory.Recipes);
    const chain = chainBuildableBlueprints(foundry.recipes, owned, db);
    const frame = foundry.recipes.find((r) => r.uniqueName === FRAME_BP);
    expect(frame).toBeDefined();
    return {
      chainBuildable: chain.has(FRAME_BP),
      ready: isFoundryRecipeReady(frame!, owned, chain),
    };
  }

  it("reports a frame ready when its parts are still craftable from owned blueprints", () => {
    const { chainBuildable, ready } = readiness({
      Recipes: [
        { ItemType: FRAME_BP, ItemCount: 13 },
        ...PARTS.map((part) => ({ ItemType: partBlueprint(part), ItemCount: 1 })),
      ],
      MiscItems: [
        { ItemType: CELL, ItemCount: 1200 },
        { ItemType: RUBEDO, ItemCount: 300 },
      ],
    } as RawInventoryData);

    // The filter admits it, so the card must not read "Missing parts".
    expect(chainBuildable).toBe(true);
    expect(ready).toBe(true);
  });

  it("reports a frame ready when the built parts are already in hand", () => {
    const { ready } = readiness({
      Recipes: [{ ItemType: FRAME_BP, ItemCount: 1 }],
      MiscItems: [
        { ItemType: CELL, ItemCount: 1200 },
        ...PARTS.map((part) => ({ ItemType: partComponent(part), ItemCount: 1 })),
      ],
    } as RawInventoryData);

    expect(ready).toBe(true);
  });

  it("keeps a frame unready when only the bulk resource is owned", () => {
    const { chainBuildable, ready } = readiness({
      Recipes: [{ ItemType: FRAME_BP, ItemCount: 13 }],
      MiscItems: [{ ItemType: CELL, ItemCount: 1200 }],
    } as RawInventoryData);

    expect(chainBuildable).toBe(false);
    expect(ready).toBe(false);
  });

  it("keeps a frame unready when a part blueprint cannot be built", () => {
    const { chainBuildable, ready } = readiness({
      Recipes: [
        { ItemType: FRAME_BP, ItemCount: 13 },
        ...PARTS.map((part) => ({ ItemType: partBlueprint(part), ItemCount: 1 })),
      ],
      MiscItems: [
        { ItemType: CELL, ItemCount: 1200 },
        { ItemType: RUBEDO, ItemCount: 250 },
      ],
    } as RawInventoryData);

    expect(chainBuildable).toBe(false);
    expect(ready).toBe(false);
  });

  // A build burns its blueprint, so a part wanted twice wants two copies unless
  // DE marks the recipe consumeOnUse=false.
  describe("part blueprint copies", () => {
    const GUN = "/Lotus/Weapons/Test/AktestPrime";
    const GUN_BP = "/Lotus/Types/Recipes/Weapons/AktestPrimeBlueprint";
    const LINK = "/Lotus/Types/Recipes/Weapons/AktestPrimeLinkComponent";
    const LINK_BP = "/Lotus/Types/Recipes/Weapons/AktestPrimeLinkBlueprint";

    type ReusableFlag = "none" | "recipe" | "blueprint";

    function gunDb(reusable: ReusableFlag): Record<string, ItemDbEntry> {
      return {
        [GUN]: {
          name: "Aktest Prime",
          recipe: {
            buildPrice: 0,
            buildTime: 0,
            num: 1,
            blueprintUniqueName: GUN_BP,
            ingredients: [
              { uniqueName: LINK, count: 2 },
              { uniqueName: CELL, count: 2 },
            ],
          },
        } as ItemDbEntry,
        [LINK]: {
          name: "Aktest Prime Link",
          componentOf: GUN,
          recipe: {
            buildPrice: 0,
            buildTime: 0,
            num: 1,
            blueprintUniqueName: LINK_BP,
            ...(reusable === "recipe" ? { reusableBlueprint: true } : {}),
            ingredients: [{ uniqueName: RUBEDO, count: 100 }],
          },
        } as ItemDbEntry,
        [LINK_BP]: {
          name: "Aktest Prime Link Blueprint",
          ...(reusable === "blueprint" ? { reusableBlueprint: true } : {}),
        } as ItemDbEntry,
      };
    }

    function gunReadiness(linkCopies: number, builtLinks: number, reusable: ReusableFlag = "none") {
      const db = gunDb(reusable);
      const inventory: RawInventoryData = {
        Recipes: [
          { ItemType: GUN_BP, ItemCount: 1 },
          { ItemType: LINK_BP, ItemCount: linkCopies },
        ],
        MiscItems: [
          { ItemType: CELL, ItemCount: 10 },
          { ItemType: RUBEDO, ItemCount: 500 },
          ...(builtLinks > 0 ? [{ ItemType: LINK, ItemCount: builtLinks }] : []),
        ],
      };
      const foundry = parseFoundry(inventory, db);
      const owned = aggregateComponentOwnership(inventory.MiscItems, inventory.Recipes);
      const chain = chainBuildableBlueprints(foundry.recipes, owned, db);
      const gun = foundry.recipes.find((r) => r.uniqueName === GUN_BP);
      expect(gun).toBeDefined();
      return {
        chainBuildable: chain.has(GUN_BP),
        ready: isFoundryRecipeReady(gun!, owned, chain),
      };
    }

    it("keeps a weapon unready when one consumed blueprint must cover two parts", () => {
      const { chainBuildable, ready } = gunReadiness(1, 0);

      expect(chainBuildable).toBe(false);
      expect(ready).toBe(false);
    });

    it("accepts a second copy of the part blueprint", () => {
      expect(gunReadiness(2, 0).ready).toBe(true);
    });

    it("accepts one built part plus one blueprint", () => {
      expect(gunReadiness(1, 1).ready).toBe(true);
    });

    it("accepts a single reusable part blueprint", () => {
      expect(gunReadiness(1, 0, "recipe").ready).toBe(true);
      expect(gunReadiness(1, 0, "blueprint").ready).toBe(true);
    });
  });
});

describe("catalog-listed ranked items", () => {
  const uskos = "/Lotus/Upgrades/CosmeticEnhancers/Antiques/HeatStatusProcOnUltimateKill";

  it("prices an arcane the catalog lists but the item database has never seen", () => {
    const items = parseInventory(
      { Upgrades: [{ ItemType: uskos, UpgradeFingerprint: '{"lvl":0}' }] },
      { [uskos]: { name: "Zid-an Uskos" } },
      new Set([gameRefKey(uskos)]),
    );

    const arcane = items.find((item) => item.internalName === uskos);
    expect(arcane?.inventoryGroup).toBe("arcanes");
    expect(arcane?.tradable).toBe(true);
  });

  it("leaves the arcane untradable when the catalog does not list it", () => {
    const items = parseInventory(
      { Upgrades: [{ ItemType: uskos, UpgradeFingerprint: '{"lvl":0}' }] },
      { [uskos]: { name: "Zid-an Uskos" } },
      new Set(),
    );

    expect(items.find((item) => item.internalName === uskos)?.tradable).toBe(false);
  });

  // The bundled item data calls 158 catalog-listed mods untradable, so its flag
  // cannot veto a listing. Veiled rivens stay out through the exclusion list.
  it("prices a listed mod the item database wrongly calls untradable", () => {
    const ghostwalk = "/Lotus/Upgrades/Mods/Antiques/Ghostwalk";
    const items = parseInventory(
      { RawUpgrades: [{ ItemType: ghostwalk, ItemCount: 1 }] },
      { [ghostwalk]: { name: "Kaal-Zidi", tradable: false } },
      new Set([gameRefKey(ghostwalk)]),
    );

    expect(items.find((item) => item.internalName === ghostwalk)?.tradable).toBe(true);
  });

  it("does not let a set listing make the assembled Warframe tradable", () => {
    const frost = "/Lotus/Powersuits/Frost/FrostPrime";
    const items = parseInventory(
      { Suits: [{ ItemType: frost, XP: 0 }] },
      { [frost]: { name: "Frost Prime", isPrime: true, tradable: false, masterable: true } },
      new Set([gameRefKey(frost)]),
    );

    expect(items.find((item) => item.internalName === frost)?.tradable).toBe(false);
  });
});
