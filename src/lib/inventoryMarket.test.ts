import { describe, expect, it } from "vitest";

import {
  buildInventoryViewItems,
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
  it("prefers local item icon for mods and arcanes", () => {
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
    expect(mapped.displayImageUrl).toBe("https://cdn.warframestat.us/img/sample_local.jpg");
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
});
