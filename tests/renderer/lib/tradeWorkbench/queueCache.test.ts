import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchQueueRow } from "../../../../src/lib/tradeWorkbench/queueModel.js";

async function loadModule() {
  vi.resetModules();
  return await import("../../../../src/lib/tradeWorkbench/queueCache.js");
}

function pricedRow(): WorkbenchQueueRow {
  return {
    rowId: "r0",
    quantity: 3,
    manualPrice: 27,
    sellBook: [{ platinum: 30, quantity: 1, status: "ingame", userName: "seller0" }],
    suggestion: { price: 29, reason: "cheapest-minus-one" },
    market: { lowestSell: 30, highestBuy: null, activeSellers: 1, spread: null },
  } as unknown as WorkbenchQueueRow;
}

beforeEach(() => vi.resetModules());

describe("workbench queue cache", () => {
  it("starts empty and hands back exactly what was written", async () => {
    const mod = await loadModule();
    expect(mod.readCachedQueueRows()).toEqual([]);

    const rows = [{ rowId: "r0" }] as unknown as Parameters<typeof mod.writeCachedQueueRows>[0];
    mod.writeCachedQueueRows(rows);
    expect(mod.readCachedQueueRows()).toBe(rows);
  });

  it("is process-lifetime only, so a fresh module load starts empty again", async () => {
    const first = await loadModule();
    first.writeCachedQueueRows([{ rowId: "r0" }] as unknown as Parameters<
      typeof first.writeCachedQueueRows
    >[0]);

    const second = await loadModule();
    expect(second.readCachedQueueRows()).toEqual([]);
  });

  it("hands back the loaded order book inside the freshness window", async () => {
    const mod = await loadModule();
    mod.markQueueMarketFetched(1_000);
    mod.writeCachedQueueRows([pricedRow()]);

    const [row] = mod.readCachedQueueRows(1_000 + mod.QUEUE_MARKET_TTL_MS);
    expect(row.sellBook).not.toBeNull();
    expect(row.suggestion?.price).toBe(29);
  });

  it("drops a stale order book and its suggestion, keeping the user's own input", async () => {
    const mod = await loadModule();
    mod.markQueueMarketFetched(1_000);
    mod.writeCachedQueueRows([pricedRow()]);

    const [row] = mod.readCachedQueueRows(1_000 + mod.QUEUE_MARKET_TTL_MS + 1);
    expect(row.sellBook).toBeNull();
    expect(row.suggestion).toBeNull();
    expect(row.market).toBeNull();
    expect(row.manualPrice).toBe(27);
    expect(row.quantity).toBe(3);
  });

  it("ages the book from its fetch, so row edits do not keep it fresh", async () => {
    const mod = await loadModule();
    mod.markQueueMarketFetched(1_000);
    mod.writeCachedQueueRows([pricedRow()]);
    // A quantity edit an hour later rewrites the rows but fetched nothing.
    mod.writeCachedQueueRows([{ ...pricedRow(), quantity: 4 }]);

    const [row] = mod.readCachedQueueRows(1_000 + mod.QUEUE_MARKET_TTL_MS + 1);
    expect(row.sellBook).toBeNull();
    expect(row.quantity).toBe(4);
  });
});
