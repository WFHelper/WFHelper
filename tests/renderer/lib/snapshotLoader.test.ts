import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBackendRaw: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: mocks.invoke }));
vi.mock("../../../src/lib/wfm/backendLite.js", () => ({
  fetchBackendRaw: mocks.fetchBackendRaw,
  isBackendLiteConfigured: () => true,
}));
vi.mock("../../../src/lib/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WFM_PRICE_BASIS } from "../../../config/shared/wfmStats.js";
import { tryLoadSnapshot } from "../../../src/lib/wfm/snapshotLoader.js";
import { getCachedPriceState } from "../../../src/lib/wfm/priceCache.js";
import { clearOrderSummaryCache } from "../../../src/lib/wfm/orderSummaryCache.js";
import {
  importSetCatalogFromSnapshotMeta,
  resolveSnapshotSetSlug,
} from "../../../src/lib/wfm/wfmItemMeta.js";

function completeSetMeta(now: number) {
  return Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => {
      const slug = `cached_${index}_set`;
      return [
        slug,
        {
          slug,
          ducats: null,
          setRoot: true,
          thumb: null,
          icon: null,
          timestamp: now - 24 * 60 * 60 * 1000,
        },
      ];
    }),
  );
}

afterEach(() => {
  mocks.fetchBackendRaw.mockReset();
  mocks.invoke.mockReset();
  importSetCatalogFromSnapshotMeta({});
  clearOrderSummaryCache();
});

describe("snapshot set-catalog fallback", () => {
  it("refreshes legacy prices even on fresh disk snapshots and keeps their catalog", async () => {
    const now = Date.now();
    const meta = completeSetMeta(now);
    mocks.invoke.mockResolvedValue({
      version: 1,
      generatedAt: now,
      prices: { legacy_item: { status: "ok", median: 999, timestamp: now } },
      meta,
      orderSummaries: {},
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    await tryLoadSnapshot();

    expect(mocks.fetchBackendRaw).toHaveBeenCalledOnce();
    expect(getCachedPriceState("legacy_item")).toBeNull();
    expect(resolveSnapshotSetSlug([Object.keys(meta)[0]])).toBe(Object.keys(meta)[0]);
  });
  it("restores a stale last-good catalog when the backend is unavailable", async () => {
    const now = Date.now();
    const meta = completeSetMeta(now);
    const firstSlug = Object.keys(meta)[0];
    mocks.invoke.mockResolvedValue({
      version: 1,
      generatedAt: now - 3 * 60 * 60 * 1000,
      prices: {},
      meta,
      orderSummaries: {},
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    await tryLoadSnapshot();

    expect(resolveSnapshotSetSlug([firstSlug])).toBe(firstSlug);
    expect(resolveSnapshotSetSlug(["seer_set"])).toBeNull();
  });
});

describe("snapshot price import", () => {
  it("skips a price far above the order book the same snapshot carries", async () => {
    const now = Date.now();
    const price = (median: number) => ({
      status: "ok",
      median,
      timestamp: now,
      priceBasis: WFM_PRICE_BASIS,
    });
    const summary = (wts: number | null, wtb: number | null) => ({
      status: "ok",
      wts,
      wtb,
      timestamp: now,
    });
    mocks.invoke.mockResolvedValue({
      version: 1,
      generatedAt: now,
      prices: {
        magazine_warp: price(69420),
        "magazine_warp:rank-v3:r0": price(69420),
        "magazine_warp:rank-v3:r5": price(15),
        "primary_compression:rank-v3:r5": price(208),
        ash_prime_blueprint: price(69420),
      },
      meta: {},
      orderSummaries: {
        "magazine_warp:r0": summary(5, null),
        "magazine_warp:r5": summary(10, null),
        "primary_compression:r5": summary(1, 185),
      },
    });

    await tryLoadSnapshot();

    expect(mocks.fetchBackendRaw).not.toHaveBeenCalled();
    expect(getCachedPriceState("magazine_warp")).toBeNull();
    expect(getCachedPriceState("magazine_warp:rank-v3:r0")).toBeNull();
    expect(getCachedPriceState("magazine_warp:rank-v3:r5")?.median).toBe(15);
    expect(getCachedPriceState("primary_compression:rank-v3:r5")?.median).toBe(208);
    expect(getCachedPriceState("ash_prime_blueprint")?.median).toBe(69420);
  });
});
