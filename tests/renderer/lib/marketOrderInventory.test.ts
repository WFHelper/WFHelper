import { describe, expect, it } from "vitest";

import {
  orderInventoryMatch,
  ownedCountForMarketOrder,
} from "../../../src/lib/marketOrderInventory.js";
import { applySharedFiltersAndSort } from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";
import type { ItemDbEntry, ParsedItem } from "../../../src/types/inventory.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";
import type { WfmOrder } from "../../../src/types/market.js";

const BASE_FILTERS: SharedFiltersState = {
  search: "",
  primeMode: "all",
  masteredMode: "all",
  sortBy: "name",
  sortDirection: "asc",
  orderPlaced: "all",
  mastered: "all",
  spares: "all",
  vaulted: "all",
  partType: "all",
  favorite: "all",
  minimumPlatinum: 0,
  minimumAmount: 0,
  equipped: "all",
  leveledUp: "all",
  subsumed: "all",
  foundryState: "all",
};

function order(overrides: Partial<WfmOrder>): WfmOrder {
  return {
    id: "0".repeat(24),
    orderType: "sell",
    platinum: 10,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: null,
    itemName: "Trinity Prime Chassis",
    itemUrlName: "trinity_prime_chassis",
    itemThumb: null,
    ...overrides,
  };
}

function parsedItem(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    name: "Trinity Prime Chassis",
    amount: 3,
    ...overrides,
  } as ParsedItem;
}

describe("ownedCountForMarketOrder", () => {
  it("returns the inventory amount for a name match", () => {
    expect(ownedCountForMarketOrder(order({}), [parsedItem({})])).toBe(3);
  });

  it("falls back to the slug when display names differ", () => {
    const inventory = [parsedItem({ name: "Trinity Prime Chassis Blueprint" })];
    expect(ownedCountForMarketOrder(order({ itemName: "Chassis" }), inventory)).toBe(0);
    expect(
      ownedCountForMarketOrder(
        order({ itemUrlName: "trinity_prime_chassis_blueprint" }),
        inventory,
      ),
    ).toBe(3);
  });

  it("joins a renamed listing to the inventory through its game reference", () => {
    const gameRef = "/Lotus/Types/Keys/InfestedAladVQuest/AssassinateInfestedAladVKey";
    const wfmItems = {
      "mutalist alad v assassinate (key)": {
        url_name: "mutalist_alad_v_assassinate_key",
        gameRef,
      },
    };
    const inventory = [
      parsedItem({ name: "Mutalist Alad V Assassinate", internalName: gameRef, amount: 8 }),
    ];
    const listing = order({
      itemName: "Mutalist Alad V Assassinate (Key)",
      itemUrlName: "mutalist_alad_v_assassinate_key",
    });
    expect(ownedCountForMarketOrder(listing, inventory)).toBe(0);
    expect(ownedCountForMarketOrder(listing, inventory, wfmItems)).toBe(8);
  });

  it("returns 0 for items missing from the inventory", () => {
    expect(ownedCountForMarketOrder(order({ itemName: "Ash Prime Systems" }), [])).toBe(0);
  });

  it("counts flag-only ownership as 1", () => {
    const inventory = [
      parsedItem({ amount: undefined as unknown as number, currentlyOwned: true }),
    ];
    expect(ownedCountForMarketOrder(order({}), inventory)).toBe(1);
  });

  it("survives an inventory row whose name is not a string", () => {
    // Seen live: one leaked non-string name crashed every market join.
    const inventory = [parsedItem({ name: 117 as unknown as string }), parsedItem({})];
    expect(ownedCountForMarketOrder(order({}), inventory)).toBe(3);
  });
});

describe("market order Owned sort", () => {
  it("ascending count surfaces owned-0 rows first and hides none", () => {
    const rows = [
      { name: "A", amount: 2, count: 5 },
      { name: "B", amount: 9, count: 0 },
      { name: "C", amount: 1, count: 2 },
    ];
    const sorted = applySharedFiltersAndSort(rows, {
      ...BASE_FILTERS,
      sortBy: "count",
      sortDirection: "asc",
    });
    expect(sorted.map((row) => row.name)).toEqual(["B", "C", "A"]);
  });
});

const PART_REF = "/Lotus/Types/Recipes/Weapons/RubicoPrimeBlueprint";
const SCENE_REF = "/Lotus/Types/Items/MiscItems/PhotoboothTileSyndicateSimarisDerelictHub";
const GEM_REF = "/Lotus/Types/Items/Gems/Eidolon/RareGemACutAItem";

function catalog(gameRef: string, urlName = "trinity_prime_chassis"): WfmItemsLookup {
  return { [urlName]: { url_name: urlName, gameRef } };
}

function mod(name: string, rank: number): ParsedItem {
  return parsedItem({ name, rank, amount: 1, inventoryGroup: "mods" });
}

describe("orderInventoryMatch", () => {
  it("stays quiet while the inventory still backs the listing", () => {
    const match = orderInventoryMatch(order({}), [parsedItem({})], catalog(PART_REF), {});
    expect(match).toEqual({ state: "match" });
  });

  it("flags a sell order for something the inventory no longer holds", () => {
    expect(orderInventoryMatch(order({}), [], catalog(PART_REF), {})).toEqual({ state: "missing" });
  });

  it("treats a row that resolves to zero owned as missing", () => {
    const inventory = [parsedItem({ amount: 0 })];
    expect(orderInventoryMatch(order({}), inventory, catalog(PART_REF), {})).toEqual({
      state: "missing",
    });
  });

  it("never flags a buy order, which needs no stock", () => {
    const buy = order({ orderType: "buy" });
    expect(orderInventoryMatch(buy, [], catalog(PART_REF), {})).toEqual({ state: "match" });
  });

  it("never flags a captura scene, which the parser drops from inventory", () => {
    expect(orderInventoryMatch(order({}), [], catalog(SCENE_REF), {})).toEqual({ state: "match" });
  });

  it("never flags a resource, which the parser also drops", () => {
    const db: Record<string, ItemDbEntry> = { [GEM_REF]: { category: "Resource" } };
    expect(orderInventoryMatch(order({}), [], catalog(GEM_REF), db)).toEqual({ state: "match" });
  });

  it("stays quiet when the catalog cannot identify the listing at all", () => {
    expect(orderInventoryMatch(order({}), [], {}, {})).toEqual({ state: "match" });
  });

  const relicOrder = (subtype: string | null): WfmOrder =>
    order({
      itemName: "Axi A1 Relic",
      itemUrlName: "axi_a1_relic",
      subtype,
    });
  const RELIC_REF = "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze";
  const relicCatalog = (): WfmItemsLookup => catalog(RELIC_REF, "axi_a1_relic");

  // Production shape: the item DB names every refinement identically, so the
  // quality only exists in the projection uniqueName's metal suffix.
  const relicRow = (metal: "Bronze" | "Silver" | "Gold" | "Platinum", amount: number): ParsedItem =>
    parsedItem({
      name: "Axi A1 Relic",
      internalName: `/Lotus/Types/Game/Projections/T4VoidProjectionE${metal}`,
      amount,
    });

  it("backs a refinement listing only with that refinement", () => {
    const radiantOwned = [relicRow("Platinum", 2)];
    expect(orderInventoryMatch(relicOrder("radiant"), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
    // An intact stack cannot fulfil a radiant order, even though both rows
    // carry the identical display name.
    const intactOwned = [relicRow("Bronze", 4)];
    expect(orderInventoryMatch(relicOrder("radiant"), intactOwned, relicCatalog(), {})).toEqual({
      state: "missing",
    });
    expect(
      orderInventoryMatch(relicOrder("exceptional"), [relicRow("Silver", 1)], relicCatalog(), {}),
    ).toEqual({
      state: "match",
    });
  });

  it("matches an intact listing to the bronze projection", () => {
    const intactOwned = [relicRow("Bronze", 4)];
    expect(orderInventoryMatch(relicOrder("intact"), intactOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
    expect(
      orderInventoryMatch(relicOrder("intact"), [relicRow("Gold", 4)], relicCatalog(), {}),
    ).toEqual({
      state: "missing",
    });
  });

  it("still reads a quality-suffixed display name when no uniqueName is present", () => {
    const radiantOwned = [parsedItem({ name: "Axi A1 Relic (Radiant)", amount: 2 })];
    expect(orderInventoryMatch(relicOrder("radiant"), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
  });

  it("lets a subtype-less relic listing match any refinement", () => {
    const radiantOwned = [relicRow("Platinum", 1)];
    expect(orderInventoryMatch(relicOrder(null), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
  });

  it("flags a listing the inventory only partly backs", () => {
    const listing = order({ quantity: 10 });
    expect(
      orderInventoryMatch(listing, [parsedItem({ amount: 1 })], catalog(PART_REF), {}),
    ).toEqual({ state: "partial", owned: 1, listed: 10 });
  });

  it("sums the rows that back one listing before calling it short", () => {
    const listing = order({ quantity: 4 });
    const inventory = [parsedItem({ amount: 3 }), parsedItem({ amount: 1 })];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });

  it("counts only the copies at the listed rank towards a ranked listing", () => {
    const listing = order({ itemName: "Serration", modRank: 10, quantity: 3 });
    const inventory = [mod("Serration", 0), mod("Serration", 10)];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "partial",
      owned: 1,
      listed: 3,
    });
  });

  it("accepts a ranked listing backed by a copy at that rank", () => {
    const listing = order({ itemName: "Serration", modRank: 10 });
    const inventory = [mod("Serration", 0), mod("Serration", 10)];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });

  it("reports the owned rank when no copy sits at the listed rank", () => {
    const listing = order({ itemName: "Serration", modRank: 10 });
    expect(orderInventoryMatch(listing, [mod("Serration", 5)], catalog(PART_REF), {})).toEqual({
      state: "rank-mismatch",
      ownedRank: 5,
    });
  });

  it("ignores rank for a group that does not carry one", () => {
    const listing = order({ modRank: 3 });
    const inventory = [parsedItem({ inventoryGroup: "all_parts", rank: 0 })];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });
});
