import { describe, expect, it } from "vitest";

import { buildParsedItemFromDb } from "../../../../src/lib/parsedItemFromDb.js";
import {
  detailedRelicFor,
  redirectItemToRelic,
  redirectRelicToItem,
  simpleRelicFor,
} from "../../../../src/lib/relic/relicView.js";
import type { ItemDbEntry } from "../../../../src/types/inventory.js";
import type { RelicDatabase, RelicGroup, RelicReward } from "../../../../src/types/relics.js";

const INTACT = "/Lotus/Types/Game/Projections/T1VoidProjectionFixtureBronze";
const RADIANT = "/Lotus/Types/Game/Projections/T1VoidProjectionFixturePlatinum";
const NEW_RELIC = "/Lotus/Types/Game/Projections/T1VoidProjectionNewBronze";
const REWARD: RelicReward = {
  name: "Fixture Prime Barrel",
  rarity: "Rare",
  chance: 2,
  urlName: null,
  ducats: 100,
};

function group(key: string, rewards: RelicReward[]): RelicGroup {
  const [tier = "", code = ""] = key.split(" ");
  return {
    key,
    name: key,
    tier,
    code,
    imageUrl: null,
    qualities: {
      intact: { uniqueName: key === "Lith Z9" ? INTACT : NEW_RELIC, rewards },
      ...(key === "Lith Z9" ? { radiant: { uniqueName: RADIANT, rewards } } : {}),
    },
  };
}

const withRewards = group("Lith Z9", [REWARD]);
const empty = group("Lith N1", []);
const relicDb: RelicDatabase = {
  groups: { "Lith Z9": withRewards, "Lith N1": empty },
  byUniqueName: {
    [INTACT]: { groupKey: "Lith Z9", quality: "intact" },
    [RADIANT]: { groupKey: "Lith Z9", quality: "radiant" },
    [NEW_RELIC]: { groupKey: "Lith N1", quality: "intact" },
  },
};
const itemDb: Record<string, ItemDbEntry> = {
  [INTACT]: { name: "Lith Z9 Relic", category: "Relics" },
  [RADIANT]: { name: "Lith Z9 Relic", category: "Relics", description: "Radiant copy" },
  [NEW_RELIC]: { name: "Lith N1 Relic", category: "Relic" },
  "/Lotus/Weapons/Fixture": { name: "Fixture Rifle", category: "Primary" },
};
const ownership = new Map<string, number>();
const item = (uniqueName: string) =>
  buildParsedItemFromDb(uniqueName, itemDb[uniqueName], ownership);

describe("relic view helpers", () => {
  it("treats a relic without any reward rows as having no breakdown", () => {
    expect(detailedRelicFor(relicDb, INTACT)).toBe(withRewards);
    expect(detailedRelicFor(relicDb, RADIANT)).toBe(withRewards);
    expect(detailedRelicFor(relicDb, NEW_RELIC)).toBeNull();
    expect(detailedRelicFor(relicDb, "/Lotus/Weapons/Fixture")).toBeNull();
    expect(detailedRelicFor(null, INTACT)).toBeNull();
    expect(detailedRelicFor(relicDb, "")).toBeNull();
  });

  it("builds the item popup from the asked refinement, else the game's tier order", () => {
    expect(simpleRelicFor(withRewards, itemDb, ownership)?.uniqueName).toBe(INTACT);
    expect(simpleRelicFor(withRewards, itemDb, ownership, "radiant")?.uniqueName).toBe(RADIANT);
    expect(simpleRelicFor(withRewards, itemDb, ownership, "flawless")?.uniqueName).toBe(INTACT);
    expect(simpleRelicFor(withRewards, {}, ownership)).toBeNull();
  });

  it("redirects an item popup only when the breakdown is remembered and has rewards", () => {
    expect(redirectItemToRelic("auto", item(INTACT), relicDb)).toBeNull();
    expect(redirectItemToRelic("simple", item(INTACT), relicDb)).toBeNull();
    expect(redirectItemToRelic("detailed", item(INTACT), relicDb)).toBe(withRewards);
    expect(redirectItemToRelic("detailed", item(NEW_RELIC), relicDb)).toBeNull();
    expect(redirectItemToRelic("detailed", item("/Lotus/Weapons/Fixture"), relicDb)).toBeNull();
  });

  it("redirects a breakdown to the item popup for simple, or when it has nothing to show", () => {
    expect(redirectRelicToItem("auto", withRewards, itemDb, ownership)).toBeNull();
    expect(redirectRelicToItem("auto", empty, itemDb, ownership)).toBeNull();
    expect(redirectRelicToItem("detailed", withRewards, itemDb, ownership)).toBeNull();
    expect(redirectRelicToItem("detailed", empty, itemDb, ownership)?.uniqueName).toBe(NEW_RELIC);
    expect(redirectRelicToItem("simple", withRewards, itemDb, ownership)?.uniqueName).toBe(INTACT);
    expect(redirectRelicToItem("simple", withRewards, {}, ownership)).toBeNull();
  });
});
