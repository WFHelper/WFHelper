import { describe, expect, it } from "vitest";

import {
  rendererOrderSummaryCacheKey,
  rendererPriceCacheKey,
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

  it("preserves Worker cache and miss key formats", () => {
    expect(workerPriceCacheKey("serration", null)).toBe("price:serration");
    expect(workerPriceCacheKey("serration", 10)).toBe("price:serration:r10");
    expect(workerOrdersCacheKey("serration", 10)).toBe("orders:serration:r10");
    expect(workerOrderSummaryCacheKey("serration", 10)).toBe("orders-summary:serration:r10");
    expect(workerMissCacheKey("miss:price:v2:", "serration", 10)).toBe(
      "miss:price:v2:serration:r10",
    );
  });
});
