import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";

const LEX_PRIME = "/Lotus/Weapons/Tenno/Pistols/PrimeLex/PrimeLex";
const LEX_RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/LexPrimeReceiver";
const RHINO = "/Lotus/Powersuits/Rhino/Rhino";

describe("aggregateComponentOwnership counts built gear", () => {
  // Aklex Prime consumes two built Lex Primes, and a built weapon lives in its
  // own collection, never in MiscItems - so ignoring those reads as "missing"
  // on gear the player is holding.
  it("counts a built weapon an akimbo recipe consumes", () => {
    const owned = aggregateComponentOwnership({
      MiscItems: [{ ItemType: LEX_RECEIVER, ItemCount: 2 }],
      Recipes: [],
      Pistols: [{ ItemType: LEX_PRIME, XP: 4053738 }, { ItemType: LEX_PRIME }],
    });

    expect(owned.get(LEX_PRIME)).toBe(2);
    expect(owned.get(LEX_RECEIVER)).toBe(2);
  });

  it("counts one copy per row, ignoring any ItemCount on built gear", () => {
    const owned = aggregateComponentOwnership({
      Suits: [{ ItemType: RHINO, ItemCount: 7 }],
    });

    expect(owned.get(RHINO)).toBe(1);
  });

  it("adds built copies to parts of the same uniqueName", () => {
    const owned = aggregateComponentOwnership({
      MiscItems: [{ ItemType: LEX_PRIME, ItemCount: 1 }],
      Pistols: [{ ItemType: LEX_PRIME }],
    });

    expect(owned.get(LEX_PRIME)).toBe(2);
  });

  it("tolerates absent and malformed collections", () => {
    const owned = aggregateComponentOwnership({
      MiscItems: [{ ItemType: LEX_RECEIVER, ItemCount: 1 }],
      Pistols: null,
      Melee: "nonsense",
      Suits: [null, {}, { ItemType: 42 }],
    });

    expect(owned.get(LEX_RECEIVER)).toBe(1);
    expect(owned.size).toBe(1);
  });
});
