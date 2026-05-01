import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOrderSummaryCache,
  getCachedOrderSummaryState,
  importOrderSummaryCache,
  isOrderSummaryFresh,
  setCachedOrderSummary,
} from "./orderSummaryCache.js";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

describe("orderSummaryCache", () => {
  beforeEach(() => {
    clearOrderSummaryCache();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    clearOrderSummaryCache();
    vi.useRealTimers();
  });

  it("returns fresh order summaries within 24 hours", () => {
    setCachedOrderSummary("primed_bane_of_corrupted", 0, { wts: 40, wtb: 24 });

    const entry = getCachedOrderSummaryState("primed_bane_of_corrupted", 0);
    expect(entry).not.toBeNull();
    expect(entry?.wts).toBe(40);
    expect(entry?.wtb).toBe(24);
    expect(entry ? isOrderSummaryFresh(entry) : false).toBe(true);
  });

  it("returns stale summaries only when allowStale is enabled", () => {
    setCachedOrderSummary("primed_flow", 5, { wts: 85, wtb: 60 });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    expect(getCachedOrderSummaryState("primed_flow", 5)).toBeNull();

    const stale = getCachedOrderSummaryState("primed_flow", 5, { allowStale: true });
    expect(stale).not.toBeNull();
    expect(stale ? isOrderSummaryFresh(stale) : true).toBe(false);
  });

  it("ignores expired imported entries", () => {
    const now = Date.now();
    const imported = importOrderSummaryCache({
      "serration:r0": {
        status: "ok",
        wts: 3,
        wtb: 1,
        timestamp: now,
      },
      "serration:r10": {
        status: "ok",
        wts: 70,
        wtb: 45,
        timestamp: now - 49 * 60 * 60 * 1000,
      },
    });

    expect(imported).toBe(1);
    expect(getCachedOrderSummaryState("serration", 0)).not.toBeNull();
    expect(getCachedOrderSummaryState("serration", 10, { allowStale: true })).toBeNull();
  });
});
