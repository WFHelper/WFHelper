import { describe, expect, it, vi } from "vitest";

import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../../../../src/lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../../../../src/types/ipc.js";
import type { HydrationContext } from "../../../../src/stores/hydration/hydrateItemMetrics.js";

const fetchPriceBySlugMock = vi.hoisted(() => vi.fn());
const fetchPriceByNameMock = vi.hoisted(() => vi.fn());
const fetchOrderSummaryBySlugMock = vi.hoisted(() => vi.fn());
const fetchWfmItemMetaBySlugMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/lib/wfm/wfmPrice.js", () => ({
  fetchPriceBySlug: fetchPriceBySlugMock,
  fetchPriceByName: fetchPriceByNameMock,
}));

vi.mock("../../../../src/lib/wfm/orderSummaryRemote.js", () => ({
  fetchOrderSummaryBySlug: fetchOrderSummaryBySlugMock,
}));

vi.mock("../../../../src/lib/wfm/orderSummaryCache.js", () => ({
  getCachedOrderSummaryState: () => null,
  setCachedOrderSummary: vi.fn(),
  setCachedOrderSummaryNoData: vi.fn(),
}));

vi.mock("../../../../src/lib/wfm/wfmItemMeta.js", () => ({
  fetchWfmItemMetaBySlug: fetchWfmItemMetaBySlugMock,
}));

vi.mock("../../../../src/lib/wfm/priceCache.js", () => ({
  getCachedPriceState: () => null,
}));

function makeItem(): InventoryBaseItem {
  return {
    name: "High Noon",
    internalName: "/Lotus/Upgrades/Mods/Melee/HighNoon",
    category: "Mods",
    categoryLabel: "Mods",
    rank: 0,
    maxRank: 3,
    imageUrl: null,
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
    marketSlug: "high_noon",
    marketThumb: null,
  };
}

function makeContext(
  onPatch: (metric: ItemMetrics) => void,
  getMetric: () => ItemMetrics | undefined = () => undefined,
): HydrationContext {
  return {
    getMetric,
    hasPriceRetryCooldown: () => false,
    setPriceRetryCooldown: vi.fn(),
    clearPriceRetryCooldown: vi.fn(),
    hasOrderRetryCooldown: () => false,
    setOrderRetryCooldown: vi.fn(),
    clearOrderRetryCooldown: vi.fn(),
    getMissingDucatRetryCount: () => 0,
    incrementMissingDucatRetryCount: vi.fn(),
    clearMissingDucatRetryCount: vi.fn(),
    queueMetricPatch: (_key, metric) => onPatch(metric),
    markPending: vi.fn(),
    clearPending: vi.fn(),
  };
}

describe("hydrateItemMetrics", () => {
  it("does not call per-slug worker routes unless network hydration is explicitly enabled", async () => {
    vi.clearAllMocks();
    const { hydrateItemMetrics } = await import("../../../../src/stores/hydration/hydrateItemMetrics.js");
    let patched: ItemMetrics | null = null;
    const needs: MetricNeeds = { price: true, ducats: true, orders: true };
    const lookup: WfmItemsLookup = {};

    await hydrateItemMetrics(
      makeContext((metric) => {
        patched = metric;
      }),
      makeItem(),
      lookup,
      needs,
    );

    expect(fetchPriceBySlugMock).not.toHaveBeenCalled();
    expect(fetchPriceByNameMock).not.toHaveBeenCalled();
    expect(fetchOrderSummaryBySlugMock).not.toHaveBeenCalled();
    expect(fetchWfmItemMetaBySlugMock).not.toHaveBeenCalled();
    expect(patched).toMatchObject({
      hasPrice: true,
      hasPriceR0: true,
      hasPriceRmax: true,
      hasOrdersR0: true,
      hasOrdersRmax: true,
      hasDucats: true,
      hasMeta: true,
    });
  });

  it("fetches ranked median prices when foreground hydration enables network access", async () => {
    vi.clearAllMocks();
    const { hydrateItemMetrics } = await import("../../../../src/stores/hydration/hydrateItemMetrics.js");
    let patched: ItemMetrics | null = null;
    const needs: MetricNeeds = { price: true, ducats: false, orders: false, network: true };
    const lookup: WfmItemsLookup = {};

    fetchPriceBySlugMock.mockImplementation(async (slug: string, options: { rank?: number }) => ({
      status: "ok",
      slug,
      median: options.rank === 3 ? 45 : 12,
      timestamp: Date.now(),
    }));

    await hydrateItemMetrics(
      makeContext((metric) => {
        patched = metric;
      }),
      makeItem(),
      lookup,
      needs,
    );

    expect(fetchPriceBySlugMock).toHaveBeenCalledWith(
      "high_noon",
      expect.objectContaining({ rank: 0 }),
    );
    expect(fetchPriceBySlugMock).toHaveBeenCalledWith(
      "high_noon",
      expect.objectContaining({ rank: 3 }),
    );
    expect(patched).toMatchObject({
      platinum: 12,
      platinumR0: 12,
      platinumRmax: 45,
      hasPrice: true,
      hasPriceR0: true,
      hasPriceRmax: true,
    });
  });

  it("replaces a stale metric slug with the item's current marketSlug", async () => {
    vi.clearAllMocks();
    const { hydrateItemMetrics } = await import("../../../../src/stores/hydration/hydrateItemMetrics.js");
    // First pass ran before the WFM catalog loaded and cached a slugified guess.
    const staleMetric: ItemMetrics = {
      platinum: null,
      ducats: null,
      slug: "ambassador_stock_blueprint",
      thumb: null,
      icon: null,
      hasPrice: false,
      hasDucats: false,
      hasMeta: false,
    };
    const item = {
      ...makeItem(),
      name: "Ambassador Stock Blueprint",
      internalName: "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorStockBlueprint",
      inventoryGroup: "all_parts" as const,
      marketSlug: "ambassador_stock",
      rank: 0,
      maxRank: 0,
    };
    const needs: MetricNeeds = { price: true, ducats: true, orders: false, network: true };

    fetchPriceBySlugMock.mockResolvedValue({ status: "ok", slug: "ambassador_stock", median: 2, timestamp: Date.now() });
    fetchWfmItemMetaBySlugMock.mockResolvedValue(null);

    await hydrateItemMetrics(
      makeContext(() => {}, () => staleMetric),
      item,
      {},
      needs,
    );

    expect(fetchPriceBySlugMock).toHaveBeenCalledWith("ambassador_stock", expect.anything());
    expect(fetchPriceBySlugMock).not.toHaveBeenCalledWith("ambassador_stock_blueprint", expect.anything());
    expect(fetchWfmItemMetaBySlugMock).toHaveBeenCalledWith("ambassador_stock", expect.anything());
  });
});
