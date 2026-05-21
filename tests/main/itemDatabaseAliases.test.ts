import { beforeAll, describe, expect, it } from "vitest";

import * as itemDb from "../../services/itemDatabase";

describe("itemDatabase WFCD alias enrichment", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("maps generic blueprint names to canonical market-facing labels", () => {
    const aeolakBarrel = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/DuviriRifleBarrelBlueprint",
    );
    const ghoulsawBlade = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GrnGhoulSawBladeBlueprint",
    );

    expect(aeolakBarrel?.name).toBe("Aeolak Barrel Blueprint");
    expect(ghoulsawBlade?.name).toBe("Ghoulsaw Blade Blueprint");
  });

  it("keeps known tradable recipe entries tradable", () => {
    const innodemBlueprint = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/Evolving/ZarimanDaggerWeaponBlueprint",
    );

    expect(innodemBlueprint?.name).toBe("Innodem Blueprint");
    expect(innodemBlueprint?.tradable).toBe(true);
  });

  it("resolves relic reward display names to the actual prime part entry", () => {
    const resolved = itemDb.lookupItemByNameOrSlug(
      "Akarius Prime Blueprint",
      "akarius_prime_blueprint",
    );

    expect(resolved?.uniqueName).toBe("/Lotus/Types/Recipes/Weapons/AkariusPrimeBlueprint");
    expect(resolved?.item.ducats).toBe(100);
    expect(resolved?.item.componentOf).toBe(
      "/Lotus/Weapons/Tenno/Pistols/PrimeAkarius/PrimeAkariusWeapon",
    );
  });

  it("preserves unresolved weapon-part tradability as unknown for renderer heuristics", () => {
    const corufellHandle = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle",
    );

    expect(corufellHandle?.name).toBe("Corufell Handle");
    expect(corufellHandle?.tradable).toBeUndefined();
  });

  it("mirrors browse.wf icons instead of exposing upstream URLs", () => {
    const boarPrime = itemDb.lookupItem("/Lotus/Weapons/Tenno/Shotgun/PrimeBoar");
    const boarBarrel = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/BoarPrimeBarrel",
    );

    expect(boarPrime?.imageUrl).toBe(
      itemDb.toIconMirrorUrl(
        "https://browse.wf/Lotus/Interface/Icons/StoreIcons/Weapons/PrimaryWeapons/Weapons/BoarPrime.png",
      ),
    );
    expect(boarBarrel?.imageUrl).toBe(
      itemDb.toIconMirrorUrl(
        "https://browse.wf/Lotus/Interface/Icons/StoreIcons/Resources/CraftingComponents/GenericGunPrimeBarrel.png",
      ),
    );
  });
});
