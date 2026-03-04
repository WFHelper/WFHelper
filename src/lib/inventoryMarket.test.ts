import { describe, expect, it } from "vitest";

import {
  buildBaseInventoryItems,
  buildInventoryViewItems,
  getLookupByName,
  metricNeedsFromFilters,
  type InventoryBaseItem,
  type ItemMetrics,
} from "./inventoryMarket.js";

function makeBaseItem(overrides: Partial<InventoryBaseItem> = {}): InventoryBaseItem {
  return {
    name: "Sample Item",
    internalName: "/Lotus/Upgrades/Mods/Sample",
    category: "mods",
    categoryLabel: "Mod",
    rank: 0,
    maxRank: 10,
    imageUrl: "https://cdn.warframestat.us/img/sample_local.jpg",
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    inventoryGroup: "mods",
    partType: "normal",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: "sample_item",
    marketThumb: "https://warframe.market/static/assets/sample_market_thumb.png",
    ...overrides,
  };
}

describe("inventoryMarket view mapping", () => {
  it("prefers market/thumb metadata for mods and arcanes", () => {
    const item = makeBaseItem();
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: 20,
        ducats: 45,
        slug: "sample_item",
        thumb: "https://warframe.market/static/assets/sample_meta_thumb.png",
        icon: "https://warframe.market/static/assets/sample_meta_icon.png",
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics, "mods");
    expect(mapped.displayImageUrl).toBe(
      "https://warframe.market/static/assets/sample_market_thumb.png",
    );
  });

  it("falls back to market thumb/meta icon when local icon is missing", () => {
    const item = makeBaseItem({ imageUrl: null, marketThumb: null });
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        ducats: null,
        slug: "sample_item",
        thumb: null,
        icon: "https://warframe.market/static/assets/sample_meta_icon.png",
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics, "mods");
    expect(mapped.displayImageUrl).toBe(
      "https://warframe.market/static/assets/sample_meta_icon.png",
    );
  });

  it("falls back to local item icon when market sources are unavailable", () => {
    const item = makeBaseItem({ marketThumb: null });
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        ducats: null,
        slug: "sample_item",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics, "mods");
    expect(mapped.displayImageUrl).toBe("https://cdn.warframestat.us/img/sample_local.jpg");
  });

  it("hydrates ducats by default on all-parts tab", () => {
    const needs = metricNeedsFromFilters(
      {
        search: "",
        primeMode: "all",
        masteredMode: "all",
        sortBy: "name",
        sortDirection: "asc",
        orderPlaced: "all",
        partType: "all",
        favorite: "all",
        minimumPlatinum: 0,
        setComplete: "all",
        equipped: "all",
        leveledUp: "all",
      },
      "all_parts",
    );

    expect(needs.price).toBe(true);
    expect(needs.ducats).toBe(true);
  });

  it("drops generated full-sets without a real market _set slug", () => {
    const setItem = makeBaseItem({
      name: "Ayatan Amber Star Set",
      internalName: "/Lotus/Types/Items/FusionTreasures/OroFusexOrnamentB#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
    });

    const dropped = buildBaseInventoryItems([setItem], "full_sets", {}, {}, {});
    expect(dropped).toHaveLength(0);

    const kept = buildBaseInventoryItems(
      [setItem],
      "full_sets",
      {
        "ayatan amber star set": {
          url_name: "ayatan_amber_star_set",
          item_name: "Ayatan Amber Star Set",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].marketSlug).toBe("ayatan_amber_star_set");
  });

  it("matches helmet blueprint names against neuroptics lookup aliases", () => {
    const match = getLookupByName("Xaku Prime Helmet Blueprint", {
      "xaku prime neuroptics blueprint": {
        item_name: "Xaku Prime Neuroptics Blueprint",
        url_name: "xaku_prime_neuroptics_blueprint",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("xaku_prime_neuroptics_blueprint");
  });
});
