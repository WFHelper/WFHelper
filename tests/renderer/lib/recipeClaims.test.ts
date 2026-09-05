import { describe, expect, it } from "vitest";

import { buildClaimResolver } from "../../../src/lib/recipeClaims.js";
import type { ItemDbEntry, MasteryStatus } from "../../../src/types/inventory.js";

const BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/BroncoPrimeBarrel";
const RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/BroncoPrimeReceiver";
const BRONCO = "/Lotus/Weapons/Tenno/Pistol/BroncoPrime";
const AKBRONCO = "/Lotus/Weapons/Tenno/Akimbo/PrimeAkimboShotGun";
const LINK = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkbroncoPrimeLink";

/** DE lists the doubled ingredient as two entries of one, so mirror that shape. */
const itemDb: Record<string, ItemDbEntry> = {
  [BARREL]: { name: "Bronco Prime Barrel", isBuildComponent: true, componentOf: BRONCO },
  [RECEIVER]: { name: "Bronco Prime Receiver", isBuildComponent: true, componentOf: BRONCO },
  [LINK]: { name: "Akbronco Prime Link", isBuildComponent: true, componentOf: AKBRONCO },
  [BRONCO]: {
    name: "Bronco Prime",
    masterable: true,
    components: [
      { name: "Barrel", uniqueName: BARREL },
      { name: "Receiver", uniqueName: RECEIVER },
    ],
  },
  [AKBRONCO]: {
    name: "Akbronco Prime",
    masterable: true,
    components: [
      { name: "Bronco Prime", uniqueName: BRONCO, itemCount: 1 },
      { name: "Bronco Prime", uniqueName: BRONCO, itemCount: 1 },
      { name: "Link", uniqueName: LINK, itemCount: 1 },
    ],
  },
};

function resolver(
  status: Record<string, MasteryStatus>,
  owned: Record<string, number>,
  keepVariants = false,
) {
  return buildClaimResolver(
    itemDb,
    (uniqueName) => status[uniqueName],
    (uniqueName) => owned[uniqueName] ?? 0,
    { keepVariants },
  );
}

describe("recipe claims up a multi-level chain", () => {
  // Bronco Prime is mastered and built once; Akbronco Prime still eats two.
  const status: Record<string, MasteryStatus> = { [BRONCO]: "mastered", [AKBRONCO]: "missing" };
  const owned = { [BRONCO]: 1, [BARREL]: 2, [RECEIVER]: 0 };

  it("reserves the barrel a mastered weapon no longer needs but its combined form does", () => {
    const resolve = resolver(status, owned);
    expect(resolve.buildsNeeded(AKBRONCO)).toBe(1);
    // Two consumed, one already built.
    expect(resolve.buildsNeeded(BRONCO)).toBe(1);

    const barrel = resolve(BARREL, 2);
    expect(barrel.sellable).toBe(1);
    expect(barrel.reserved).toBe(1);
    expect(barrel.claims).toEqual([
      expect.objectContaining({ parentName: "Bronco Prime", count: 1 }),
    ]);
    // The barrel is held for a mastered weapon, so the chain has to name the
    // unfinished build that is really asking for it.
    expect(barrel.claims[0]?.chain.map((node) => node.name)).toEqual([
      "Bronco Prime",
      "Akbronco Prime",
    ]);
    const chain = barrel.claims[0]?.chain ?? [];
    expect(chain[chain.length - 1]?.status).toBe("missing");
  });

  it("keeps an extra set when the player wants both variants", () => {
    const resolve = resolver(status, owned, true);
    // Two to consume plus one to keep, minus the one already built.
    expect(resolve.buildsNeeded(BRONCO)).toBe(2);
    expect(resolve(BARREL, 2).sellable).toBe(0);
  });

  it("frees the part once every recipe above it is finished", () => {
    const resolve = resolver({ [BRONCO]: "mastered", [AKBRONCO]: "mastered" }, { [AKBRONCO]: 1 });
    const barrel = resolve(BARREL, 2);
    expect(barrel.sellable).toBe(2);
    expect(barrel.reserved).toBe(0);
    expect(barrel.claims).toEqual([]);
  });

  it("counts a doubled ingredient once per copy the recipe consumes", () => {
    const resolve = resolver({ [AKBRONCO]: "missing" }, {});
    // Nothing built yet: two Broncos for the Ak, and mastering Bronco is free
    // because a copy can be levelled before it is consumed.
    expect(resolve.buildsNeeded(BRONCO)).toBe(2);
    expect(resolve(BARREL, 5).sellable).toBe(3);
  });

  it("does not treat a part as its own mastery target", () => {
    const resolve = resolver({ [AKBRONCO]: "mastered", [BRONCO]: "mastered" }, { [BRONCO]: 2 });
    expect(resolve.buildsNeeded(BARREL)).toBe(0);
  });
});

describe("recipe claims guard against cycles", () => {
  const A = "/Lotus/Test/A";
  const B = "/Lotus/Test/B";
  const cyclic: Record<string, ItemDbEntry> = {
    [A]: { name: "A", masterable: true, components: [{ name: "B", uniqueName: B }] },
    [B]: { name: "B", masterable: true, components: [{ name: "A", uniqueName: A }] },
  };

  it("stops at the repeated ingredient instead of recursing forever", () => {
    const resolve = buildClaimResolver(
      cyclic,
      () => "missing",
      () => 0,
      {},
    );
    expect(resolve.buildsNeeded(A)).toBe(1);
    expect(resolve(B, 1).sellable).toBe(0);
  });
});
