import { beforeAll, describe, expect, it } from "vitest";

const itemDb = require("../../services/itemDatabase.js");

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

  it("preserves unresolved weapon-part tradability as unknown for renderer heuristics", () => {
    const corufellHandle = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle",
    );

    expect(corufellHandle?.name).toBe("Corufell Handle");
    expect(corufellHandle?.tradable).toBeUndefined();
  });
});
