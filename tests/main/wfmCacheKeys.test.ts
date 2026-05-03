import { describe, expect, it } from "vitest";

import {
  parseWfmCacheKey,
  rendererOrderBookCacheKey,
  rendererOrderSummaryCacheKey,
  rendererPriceCacheKey,
  rendererRankedRequestKey,
  snapshotCacheKeyFromWorkerKey,
  snapshotOrderSummaryCacheKey,
  snapshotPriceCacheKey,
  workerMissCacheKey,
  workerOrderSummaryCacheKey,
  workerOrdersCacheKey,
  workerPriceCacheKey,
} from "../../config/shared/wfmCacheKeys";

describe("shared WFM cache keys", () => {
  it("preserves renderer snapshot key formats", () => {
    expect(rendererPriceCacheKey("serration", null)).toBe("serration");
    expect(rendererPriceCacheKey("serration", 10)).toBe("serration:rank-v3:r10");
    expect(snapshotPriceCacheKey("serration", 10)).toBe(rendererPriceCacheKey("serration", 10));
    expect(rendererOrderSummaryCacheKey("serration", 10)).toBe("serration:r10");
    expect(snapshotOrderSummaryCacheKey("serration", 10)).toBe(
      rendererOrderSummaryCacheKey("serration", 10),
    );
  });

  it("round-trips renderer ranked cache keys through the shared parser", () => {
    const price = parseWfmCacheKey(rendererPriceCacheKey("serration", 10));
    expect(price).toEqual({ namespace: "renderer-price", slug: "serration", rank: 10 });
    expect(rendererPriceCacheKey(price!.slug, price!.rank)).toBe("serration:rank-v3:r10");

    for (const key of [
      rendererOrderBookCacheKey("serration", 10),
      rendererRankedRequestKey("serration", 10),
    ]) {
      const parsed = parseWfmCacheKey(key);
      expect(parsed).toEqual({ namespace: "renderer-ranked", slug: "serration", rank: 10 });
      expect(rendererOrderBookCacheKey(parsed!.slug, parsed!.rank)).toBe("serration:r10");
    }
  });

  it("preserves Worker cache and miss key formats", () => {
    expect(workerPriceCacheKey("serration", null)).toBe("price:serration");
    expect(workerPriceCacheKey("serration", 10)).toBe("price:serration:r10");
    expect(workerOrdersCacheKey("serration", 10)).toBe("orders:serration:r10");
    expect(workerOrderSummaryCacheKey("serration", 10)).toBe("orders-summary:serration:r10");
    expect(workerMissCacheKey("miss:price:v2:", "serration", 10)).toBe(
      "miss:price:v2:serration:r10",
    );
  });

  it("translates Worker ranked keys to snapshot keys explicitly", () => {
    const workerPrice = workerPriceCacheKey("serration", 10);
    const workerSummary = workerOrderSummaryCacheKey("serration", 10);

    expect(parseWfmCacheKey(workerPrice)).toEqual({
      namespace: "worker-price",
      slug: "serration",
      rank: 10,
    });
    expect(parseWfmCacheKey(workerSummary)).toEqual({
      namespace: "worker-order-summary",
      slug: "serration",
      rank: 10,
    });
    expect(snapshotCacheKeyFromWorkerKey(workerPrice)).toBe(snapshotPriceCacheKey("serration", 10));
    expect(snapshotCacheKeyFromWorkerKey(workerSummary)).toBe(
      snapshotOrderSummaryCacheKey("serration", 10),
    );
    expect(snapshotCacheKeyFromWorkerKey(workerOrdersCacheKey("serration", 10))).toBeNull();
  });
});
