import { describe, expect, it } from "vitest";

import {
  buildBaseInventoryItems,
  buildInventoryViewItems,
  getLookupByName,
  metricNeedsFromFilters,
  shouldHydrateMetrics,
  type InventoryBaseItem,
  type ItemMetrics,
} from "../../../src/lib/inventoryMarket.js";
import type { RelicDatabase } from "../../../src/types/relics.js";
import { setCachedPrice } from "../../../src/lib/wfm/priceCache.js";
import {
  clearOrderSummaryCache,
  setCachedOrderSummary,
} from "../../../src/lib/wfm/orderSummaryCache.js";
import { importMetaFromSnapshot } from "../../../src/lib/wfm/wfmItemMeta.js";

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

    const [mapped] = buildInventoryViewItems([item], metrics);
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

    const [mapped] = buildInventoryViewItems([item], metrics);
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

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.displayImageUrl).toBe("https://cdn.warframestat.us/img/sample_local.jpg");
  });

  it("uses cached ranked order summaries when metrics are not yet hydrated", () => {
    clearOrderSummaryCache();
    const item = makeBaseItem({ marketSlug: "sample_item", maxRank: 10 });

    setCachedOrderSummary("sample_item", 0, { wts: 9, wtb: 4 });
    setCachedOrderSummary("sample_item", 10, { wts: 33, wtb: 21 });

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.wtsR0).toBe(9);
    expect(mapped.wtbR0).toBe(4);
    expect(mapped.wtsRmax).toBe(33);
    expect(mapped.wtbRmax).toBe(21);

    clearOrderSummaryCache();
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
        vaulted: "all",
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

  it("drops all-parts entries without market mapping when tradability is unknown", () => {
    const unknownPart = makeBaseItem({
      name: "Broken War War Blade",
      internalName: "/Lotus/Types/Recipes/Weapons/WeaponParts/WarBlade",
      inventoryGroup: "all_parts",
      category: "all_parts",
      categoryLabel: "All Parts",
      tradable: false,
    });

    const mapped = buildBaseInventoryItems([unknownPart], "all_parts", {}, {}, {});
    expect(mapped).toHaveLength(0);
  });

  it("keeps explicit tradable all-parts entries even without direct lookup mapping", () => {
    const explicitTradablePart = makeBaseItem({
      name: "Some Tradable Part",
      internalName: "/Lotus/Types/Recipes/Weapons/WeaponParts/TestPart",
      inventoryGroup: "all_parts",
      category: "all_parts",
      categoryLabel: "All Parts",
      tradable: true,
    });

    const mapped = buildBaseInventoryItems([explicitTradablePart], "all_parts", {}, {}, {});
    expect(mapped).toHaveLength(1);
    expect(mapped[0].marketSlug).toBe("some_tradable_part");
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

  it("matches component blueprint names against non-blueprint lookup aliases", () => {
    const match = getLookupByName("Nova Prime Chassis Blueprint", {
      "nova prime chassis": {
        item_name: "Nova Prime Chassis",
        url_name: "nova_prime_chassis",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("nova_prime_chassis");
  });

  it("matches non-blueprint component names against blueprint lookup aliases", () => {
    const match = getLookupByName("Parallax Engines", {
      "parallax engines blueprint": {
        item_name: "Parallax Engines Blueprint",
        url_name: "parallax_engines_blueprint",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("parallax_engines_blueprint");
  });

  it("matches hyphenated item names against space-normalized lookup aliases", () => {
    const match = getLookupByName("Riot-848 Stock Blueprint", {
      "riot 848 stock": {
        item_name: "Riot 848 Stock",
        url_name: "riot_848_stock",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("riot_848_stock");
  });

  it("normalizes relic names and slugs using relic database mapping", () => {
    const relicItem = makeBaseItem({
      name: "Axi A1 Relic",
      internalName: "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze",
      category: "relics",
      categoryLabel: "Relic",
      inventoryGroup: "relics",
      maxRank: 0,
      rank: 0,
    });

    const relicDb: RelicDatabase = {
      groups: {
        "Axi A1": {
          key: "Axi A1",
          name: "Axi A1",
          tier: "Axi",
          code: "A1",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze": {
          groupKey: "Axi A1",
          quality: "intact",
        },
      },
    };

    const [mapped] = buildBaseInventoryItems([relicItem], "relics", {}, {}, {}, relicDb);
    expect(mapped.name).toBe("Axi A1 Relic");
    expect(mapped.marketSlug).toBe("axi_a1_relic");
  });

  it("sanitizes non-finite metric numbers to avoid NaN display values", () => {
    const item = makeBaseItem({
      inventoryGroup: "all_parts",
      category: "parts",
      categoryLabel: "Part",
      ducats: Number.NaN,
    });

    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: Number.NaN,
        ducats: Number.NaN,
        slug: "sample_item",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.platinum).toBeNull();
    expect(mapped.ducats).toBeNull();
    expect(mapped.ducatonator).toBeNull();
  });

  it("uses WFM max rank metadata for mods/arcanes", () => {
    const item = makeBaseItem({ rank: 3, maxRank: 10, name: "Accelerated Blast" });
    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "accelerated blast": {
          url_name: "accelerated_blast",
          item_name: "Accelerated Blast",
          thumb: null,
          icon: null,
          maxRank: 3,
        },
      },
      {},
      {},
    );

    expect(mapped.maxRank).toBe(3);
    expect(mapped.rank).toBe(3);
  });

  it("reads cached ranked prices immediately when hydration metrics are empty", () => {
    const item = makeBaseItem({
      name: "Accelerated Blast",
      marketSlug: "accelerated_blast",
      rank: 3,
      maxRank: 3,
    });
    setCachedPrice("accelerated_blast:rank-v3:r3", 6);

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.platinum).toBe(6);
  });

  it("reads cached R0 and Rmax prices for ranked cards", () => {
    const item = makeBaseItem({
      name: "Serration",
      marketSlug: "serration",
      rank: 0,
      maxRank: 10,
    });
    setCachedPrice("serration:rank-v3:r0", 8);
    setCachedPrice("serration:rank-v3:r10", 82);

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.platinumR0).toBe(8);
    expect(mapped.platinumRmax).toBe(82);
    expect(mapped.platinum).toBe(8);
  });

  it("maps both R0 and Rmax prices for ranked cards", () => {
    const item = makeBaseItem({
      name: "Critical Delay",
      marketSlug: "critical_delay",
      rank: 0,
      maxRank: 10,
    });

    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        platinumR0: 7,
        platinumRmax: 76,
        hasPriceR0: true,
        hasPriceRmax: true,
        ducats: null,
        slug: "critical_delay",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.platinumR0).toBe(7);
    expect(mapped.platinumRmax).toBe(76);
    expect(mapped.platinum).toBe(7);
  });

  it("builds one header card per mapped inventory item", () => {
    const viewItems = buildInventoryViewItems(
      [
        makeBaseItem({ internalName: "/Lotus/Upgrades/Mods/Test/A", amount: 250 }),
        makeBaseItem({ internalName: "/Lotus/Upgrades/Mods/Test/B", amount: 1 }),
      ],
      {},
    );
    expect(viewItems).toHaveLength(2);
  });

  it("resolves mod slug by gameRef mapping when name differs", () => {
    const item = makeBaseItem({
      name: "Primed Bane of Orokin",
      internalName: "/Lotus/Upgrades/Mods/Shotgun/Expert/WeaponShotgunFactionDamageCorruptedExpert",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "/lotus/upgrades/mods/shotgun/expert/weaponshotgunfactiondamagecorruptedexpert": {
          url_name: "primed_cleanse_corrupted",
          item_name: "Primed Cleanse Orokin",
          gameRef: "/Lotus/Upgrades/Mods/Shotgun/Expert/WeaponShotgunFactionDamageCorruptedExpert",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBe("primed_cleanse_corrupted");
  });

  it("uses cached snapshot meta thumbnails for ranked items before hydration", () => {
    importMetaFromSnapshot({
      primed_continuity: {
        slug: "primed_continuity",
        ducats: null,
        setRoot: false,
        thumb: "https://warframe.market/static/assets/primed_continuity_thumb.png",
        icon: null,
        timestamp: Date.now(),
      },
    });

    const [mapped] = buildBaseInventoryItems(
      [
        makeBaseItem({
          name: "Primed Continuity",
          internalName: "/Lotus/Upgrades/Mods/PrimedContinuity",
          marketThumb: null,
          marketSlug: null,
        }),
      ],
      "mods",
      {
        "primed continuity": {
          url_name: "primed_continuity",
          item_name: "Primed Continuity",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketThumb).toBe(
      "https://warframe.market/static/assets/primed_continuity_thumb.png",
    );
  });

  it("keeps untradable mods visible but without market indexing", () => {
    const item = makeBaseItem({
      name: "Amalgam Furax Body Count",
      tradable: false,
      internalName: "/Lotus/Upgrades/Mods/Custom/AmalgamFuraxBodyCount",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "amalgam furax body count": {
          url_name: "amalgam_furax_body_count",
          item_name: "Amalgam Furax Body Count",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });

  it("hard-excludes veiled riven mods from ranked market indexing", () => {
    const item = makeBaseItem({
      name: "Pistol Riven Mod (Veiled)",
      internalName: "/Lotus/Upgrades/Mods/Randomized/Secondary/PistolRivenVeiled",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "pistol riven mod (veiled)": {
          url_name: "pistol_riven_mod_(veiled)",
          item_name: "Pistol Riven Mod (Veiled)",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });

  it("hard-excludes blood for mods from ranked market indexing", () => {
    const item = makeBaseItem({
      name: "Blood For Energy",
      internalName: "/Lotus/Upgrades/Mods/DataSpike/Assassin/OnExecutionEnergyDropMod",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "blood for energy": {
          url_name: "blood_for_energy",
          item_name: "Blood For Energy",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });
});
