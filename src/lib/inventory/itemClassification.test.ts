import { describe, expect, it } from "vitest";

import {
  resolveItem,
  isArcaneUpgrade,
  isFocusUpgrade,
  isLikelyModUpgrade,
  isRelicLikeItem,
  isSceneLikeItem,
  isAyatanLikeItem,
  isBuildPartItem,
  canonicalBuildPartName,
  shouldHide,
  inferCategory,
  deriveGroup,
} from "./itemClassification.js";
import type { ResolvedItem } from "./itemClassification.js";
import type { ItemDbEntry } from "../../types/inventory.js";

// ---------------------------------------------------------------------------
// Helpers to create test fixtures
// ---------------------------------------------------------------------------

function resolved(name: string, extra: Partial<ResolvedItem> = {}): ResolvedItem {
  return { name, imageUrl: null, ...extra };
}

// ---------------------------------------------------------------------------
// resolveItem
// ---------------------------------------------------------------------------

describe("resolveItem", () => {
  it("returns the db entry name when present", () => {
    const db = { "/Lotus/Foo": { name: "Foo Prime", imageUrl: "/img.png" } };
    const result = resolveItem("/Lotus/Foo", db);
    expect(result.name).toBe("Foo Prime");
    expect(result.imageUrl).toBe("/img.png");
  });

  it("derives a name from the internal path when not in db", () => {
    const result = resolveItem("/Lotus/Types/Items/FusionBundles/RareFusion", {});
    expect(result.name).toBe("Rare Fusion");
    expect(result.imageUrl).toBeNull();
  });

  it('returns "Unknown" for empty internalName', () => {
    const result = resolveItem("", {});
    expect(result.name).toBe("Unknown");
  });

  it("inserts spaces between camelCase segments", () => {
    const result = resolveItem("/Lotus/Items/WeaponParts/BratonBarrel", {});
    expect(result.name).toBe("Braton Barrel");
  });
});

// ---------------------------------------------------------------------------
// isArcaneUpgrade
// ---------------------------------------------------------------------------

describe("isArcaneUpgrade", () => {
  it("matches by /Arcanes/ path", () => {
    expect(
      isArcaneUpgrade("/Lotus/Upgrades/Arcanes/ArcaneGrace", {}, resolved("Arcane Grace")),
    ).toBe(true);
  });

  it("matches by /CosmeticEnhancers/ path", () => {
    expect(isArcaneUpgrade("/Lotus/CosmeticEnhancers/Foo", {}, resolved("Foo"))).toBe(true);
  });

  it("matches by category", () => {
    expect(isArcaneUpgrade("/Lotus/X", { category: "Arcane Enhancement" }, resolved("X"))).toBe(
      true,
    );
  });

  it("matches by name starting with 'arcane '", () => {
    expect(isArcaneUpgrade("/Lotus/X", {}, resolved("Arcane Energize"))).toBe(true);
  });

  it("returns false for non-arcanes", () => {
    expect(
      isArcaneUpgrade("/Lotus/Mods/Rifle/Serration", { category: "Mods" }, resolved("Serration")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFocusUpgrade
// ---------------------------------------------------------------------------

describe("isFocusUpgrade", () => {
  it("matches by /Upgrades/Focus/ path", () => {
    expect(isFocusUpgrade("/Lotus/Upgrades/Focus/FooWaybound", {}, resolved("Foo Waybound"))).toBe(
      true,
    );
  });

  it("matches by type containing 'focus way'", () => {
    expect(isFocusUpgrade("/Lotus/X", { type: "Focus Way" }, resolved("X"))).toBe(true);
  });

  it("matches by name containing 'waybound'", () => {
    expect(isFocusUpgrade("/Lotus/X", {}, resolved("Inner Gaze Waybound"))).toBe(true);
  });

  it("returns false for non-focus", () => {
    expect(isFocusUpgrade("/Lotus/Mods/Rifle/Serration", {}, resolved("Serration"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLikelyModUpgrade
// ---------------------------------------------------------------------------

describe("isLikelyModUpgrade", () => {
  it("matches by /Upgrades/Mods/ path", () => {
    expect(
      isLikelyModUpgrade("/Lotus/Upgrades/Mods/Rifle/Serration", {}, resolved("Serration")),
    ).toBe(true);
  });

  it("excludes FusionBundles", () => {
    expect(isLikelyModUpgrade("/Lotus/FusionBundles/Rare", {}, resolved("Rare Fusion"))).toBe(
      false,
    );
  });

  it("excludes resources by category", () => {
    expect(isLikelyModUpgrade("/Lotus/X", { category: "Resource" }, resolved("X"))).toBe(false);
  });

  it("matches by category containing 'mod'", () => {
    expect(isLikelyModUpgrade("/Lotus/X", { category: "Mod" }, resolved("X"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isRelicLikeItem
// ---------------------------------------------------------------------------

describe("isRelicLikeItem", () => {
  it("matches by /Relics/ path", () => {
    expect(isRelicLikeItem("/Lotus/Relics/NeoN1Intact", {})).toBe(true);
  });

  it("matches by VoidProjection path", () => {
    expect(isRelicLikeItem("/Lotus/VoidProjection/NeoN1", {})).toBe(true);
  });

  it("matches by category", () => {
    expect(isRelicLikeItem("/Lotus/X", { category: "Relic" })).toBe(true);
  });

  it("matches by name containing 'relic'", () => {
    expect(isRelicLikeItem("/Lotus/X", {}, resolved("Neo N1 Relic"))).toBe(true);
  });

  it("returns false for non-relics", () => {
    expect(isRelicLikeItem("/Lotus/Types/Items/Foo", {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSceneLikeItem
// ---------------------------------------------------------------------------

describe("isSceneLikeItem", () => {
  it("matches by /PhotoBooth/ path", () => {
    expect(isSceneLikeItem("/Lotus/PhotoBooth/CapturaScene", {})).toBe(true);
  });

  it("matches by type containing 'scene'", () => {
    expect(isSceneLikeItem("/Lotus/X", { type: "Captura Scene" })).toBe(true);
  });

  it("matches by name ending with ' scene'", () => {
    expect(isSceneLikeItem("/Lotus/X", {}, resolved("Grineer Galleon Scene"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAyatanLikeItem
// ---------------------------------------------------------------------------

describe("isAyatanLikeItem", () => {
  it("matches by /FusionTreasures/ path", () => {
    expect(isAyatanLikeItem("/Lotus/FusionTreasures/Anasa", {})).toBe(true);
  });

  it("matches by name containing 'ayatan'", () => {
    expect(isAyatanLikeItem("/Lotus/X", {}, resolved("Ayatan Anasa Sculpture"))).toBe(true);
  });

  it("matches by type containing 'sculpture'", () => {
    expect(isAyatanLikeItem("/Lotus/X", { type: "Sculpture" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBuildPartItem
// ---------------------------------------------------------------------------

describe("isBuildPartItem", () => {
  it("identifies a prime tradable recipe as a build part", () => {
    const db: ItemDbEntry = { tradable: true, isPrime: true };
    const name = "Braton Prime Barrel";
    expect(
      isBuildPartItem("/Lotus/Types/Recipes/Weapons/WeaponParts/BratonBarrel", db, resolved(name)),
    ).toBe(true);
  });

  it("excludes non-tradable items", () => {
    const db: ItemDbEntry = { tradable: false };
    expect(
      isBuildPartItem("/Lotus/Types/Recipes/Weapons/WeaponParts/Foo", db, resolved("Foo Barrel")),
    ).toBe(false);
  });

  it("excludes scene-like items", () => {
    const db: ItemDbEntry = { tradable: true };
    expect(isBuildPartItem("/Lotus/PhotoBooth/FooBlueprint", db, resolved("Foo Blueprint"))).toBe(
      false,
    );
  });

  it("excludes relic-like items", () => {
    const db: ItemDbEntry = { tradable: true };
    expect(isBuildPartItem("/Lotus/Relics/NeoN1Intact", db, resolved("Neo N1 Blueprint"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// canonicalBuildPartName
// ---------------------------------------------------------------------------

describe("canonicalBuildPartName", () => {
  it("renames Helmet Blueprint to Neuroptics Blueprint for warframe recipes", () => {
    const result = canonicalBuildPartName(
      "/Lotus/Types/Recipes/WarframeRecipes/SarynHelmet",
      "Saryn Prime Helmet Blueprint",
    );
    expect(result).toBe("Saryn Prime Neuroptics Blueprint");
  });

  it("does not rename non-warframe recipes", () => {
    const result = canonicalBuildPartName(
      "/Lotus/Types/Recipes/Weapons/SomethingHelmet",
      "Something Helmet Blueprint",
    );
    expect(result).toBe("Something Helmet Blueprint");
  });
});

// ---------------------------------------------------------------------------
// shouldHide
// ---------------------------------------------------------------------------

describe("shouldHide", () => {
  it("hides focus upgrades", () => {
    expect(shouldHide("/Lotus/Upgrades/Focus/FooWaybound", {}, resolved("Foo Waybound"))).toBe(
      true,
    );
  });

  it("hides boosters", () => {
    expect(
      shouldHide("/Lotus/Types/Boosters/ResourceBooster", {}, resolved("Resource Booster")),
    ).toBe(true);
  });

  it("hides exalted weapons by dbEntry flag", () => {
    expect(shouldHide("/Lotus/X", { exalted: true }, resolved("Exalted X"))).toBe(true);
  });

  it("hides known exalted weapon names", () => {
    expect(shouldHide("/Lotus/X", {}, resolved("Exalted Blade"))).toBe(true);
  });

  it("hides non-relic keys", () => {
    expect(shouldHide("/Lotus/Types/Keys/AssassinKey", {}, resolved("Assassin Key"))).toBe(true);
  });

  it("does NOT hide relic-like keys", () => {
    expect(
      shouldHide(
        "/Lotus/Types/Keys/VoidProjectionNeoN1",
        { category: "Relic" },
        resolved("Neo N1 Relic"),
      ),
    ).toBe(false);
  });

  it("does not hide normal items", () => {
    expect(shouldHide("/Lotus/Types/Items/Foo", {}, resolved("Foo"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inferCategory
// ---------------------------------------------------------------------------

describe("inferCategory", () => {
  it("maps OperatorAmplifiers path to amps", () => {
    expect(inferCategory("/Lotus/OperatorAmplifiers/Foo", "misc")).toBe("amps");
  });

  it("uses productCategory mapping when available", () => {
    expect(inferCategory("/Lotus/X", "misc", { productCategory: "Suits" })).toBe("warframes");
  });

  it("falls back to default category", () => {
    expect(inferCategory("/Lotus/X", "misc", {})).toBe("misc");
  });
});

// ---------------------------------------------------------------------------
// deriveGroup
// ---------------------------------------------------------------------------

describe("deriveGroup", () => {
  it("classifies equipment collection keys as misc", () => {
    expect(deriveGroup("Suits", "/Lotus/Types/Warframe/Excalibur", {}, resolved("Excalibur"))).toBe(
      "misc",
    );
  });

  it("classifies LevelKeys relics as relics", () => {
    expect(
      deriveGroup(
        "LevelKeys",
        "/Lotus/VoidProjection/NeoN1",
        { category: "Relic" },
        resolved("Neo N1 Relic"),
      ),
    ).toBe("relics");
  });

  it("classifies LevelKeys non-relics as misc", () => {
    expect(deriveGroup("LevelKeys", "/Lotus/Types/Keys/SomeKey", {}, resolved("Some Key"))).toBe(
      "misc",
    );
  });

  it("classifies Arcanes source as arcanes", () => {
    expect(deriveGroup("Arcanes", "/Lotus/X", {}, resolved("Arcane Grace"))).toBe("arcanes");
  });

  it("classifies Upgrades arcane as arcanes", () => {
    expect(
      deriveGroup("Upgrades", "/Lotus/Upgrades/Arcanes/Grace", {}, resolved("Arcane Grace")),
    ).toBe("arcanes");
  });

  it("classifies Upgrades mod as mods", () => {
    expect(
      deriveGroup("Upgrades", "/Lotus/Upgrades/Mods/Rifle/Serration", {}, resolved("Serration")),
    ).toBe("mods");
  });

  it("classifies Upgrades non-mod/arcane as misc", () => {
    expect(
      deriveGroup(
        "Upgrades",
        "/Lotus/FusionBundles/Rare",
        { category: "Fusion" },
        resolved("Rare Fusion Bundle"),
      ),
    ).toBe("misc");
  });

  it("classifies build parts as all_parts", () => {
    const db: ItemDbEntry = { tradable: true, isPrime: true };
    expect(
      deriveGroup("MiscItems", "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonBarrel", db, {
        ...resolved("Braton Prime Barrel"),
        isPrime: true,
      }),
    ).toBe("all_parts");
  });

  it("classifies generic misc items as misc", () => {
    expect(
      deriveGroup(
        "MiscItems",
        "/Lotus/Types/Items/Fish/FishA",
        { category: "Fish" },
        resolved("Fish A"),
      ),
    ).toBe("misc");
  });
});
