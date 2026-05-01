import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InventoryBaseItem, MetricNeeds } from "../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { HydrationContext } from "./hydration/hydrateItemMetrics.js";

const hydrateItemMetricsMock = vi.hoisted(() => vi.fn());

vi.mock("./hydration/hydrateItemMetrics.js", () => ({
  hydrateItemMetrics: hydrateItemMetricsMock,
}));

vi.mock("../lib/wfm/wfmPrice.js", () => ({
  getPriceDebugCounters: () => ({
    requests: 0,
    cacheHitOk: 0,
    cacheHitNoData: 0,
    inFlightDeduped: 0,
    httpCalls: 0,
    resultOk: 0,
    resultNoData: 0,
    resultTransient: 0,
    rateLimited: 0,
    backendHitOk: 0,
    backendHitNoData: 0,
    backendError: 0,
    queueDropped: 0,
  }),
  getPriceQueueStats: () => ({
    high: 0,
    normal: 0,
    low: 0,
    running: false,
    delayMs: 0,
  }),
}));

vi.mock("../lib/wfm/orderBook.js", () => ({
  getOrderBookDebugCounters: () => ({
    requests: 0,
    cacheHitOk: 0,
    cacheHitNoData: 0,
    httpCalls: 0,
    v1FallbackCalls: 0,
    resultOk: 0,
    resultNoData: 0,
    resultError: 0,
  }),
}));

vi.mock("../lib/wfm/orderSummaryRemote.js", () => ({
  getOrderSummaryDebugCounters: () => ({
    requests: 0,
    backendHitOk: 0,
    backendHitNoData: 0,
    backendError: 0,
    breakerOpen: 0,
  }),
}));

function makeItem(index: number): InventoryBaseItem {
  return {
    name: `Test Item ${index}`,
    internalName: `/Lotus/Test/Item${index}`,
    category: "Misc",
    categoryLabel: "Misc",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    inventoryGroup: "misc",
    partType: "normal",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: `test_item_${index}`,
    marketThumb: null,
  };
}

describe("createInventoryHydrationController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hydrateItemMetricsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates queued items in fixed batches and ignores duplicate enqueue attempts", async () => {
    const { createInventoryHydrationController } = await import("./inventoryHydration.js");
    const { HYDRATION_BATCH_SIZE, HYDRATION_TICK_MS } = await import(
      "./hydration/hydrationTypes.js"
    );
    const hydratedKeys: string[] = [];

    hydrateItemMetricsMock.mockImplementation(
      async (ctx: HydrationContext, item: InventoryBaseItem) => {
        ctx.markPending(item.internalName);
        hydratedKeys.push(item.internalName);
        await Promise.resolve();
        ctx.clearPending(item.internalName);
      },
    );

    const controller = createInventoryHydrationController();
    const items = Array.from({ length: HYDRATION_BATCH_SIZE * 2 + 1 }, (_, index) =>
      makeItem(index),
    );
    const lookup: WfmItemsLookup = {};
    const needs: MetricNeeds = { price: true, ducats: false, orders: false };

    controller.enqueue(items, lookup, needs);
    controller.enqueue(items, lookup, needs);

    expect(hydratedKeys).toHaveLength(HYDRATION_BATCH_SIZE);

    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS);

    expect(hydratedKeys).toHaveLength(HYDRATION_BATCH_SIZE * 2);

    await vi.advanceTimersByTimeAsync(HYDRATION_TICK_MS);

    expect(hydratedKeys).toHaveLength(items.length);
    expect(new Set(hydratedKeys).size).toBe(items.length);

    controller.destroy();
  });
});
