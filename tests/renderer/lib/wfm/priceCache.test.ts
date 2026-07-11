import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __test__,
  getCachedPriceState,
  importCache,
  setCachedPrice,
} from "../../../../src/lib/wfm/priceCache.js";

const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

describe("priceCache", () => {
  beforeEach(() => {
    __test__.clearPriceCache();
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    __test__.clearPriceCache();
    vi.useRealTimers();
  });

  it("keeps snapshot prices within the worker refresh window", () => {
    // Worker entries can be ~42h old (21h staleness + ranked prewarm walk).
    const imported = importCache({
      ash_prime_set: {
        status: "ok",
        median: 55,
        timestamp: Date.now() - 42 * 60 * 60 * 1000,
      },
    });

    expect(imported).toBe(1);
    expect(getCachedPriceState("ash_prime_set")).toMatchObject({
      status: "ok",
      median: 55,
    });
  });

  it("ignores expired snapshot prices", () => {
    const imported = importCache({
      ash_prime_set: {
        status: "ok",
        median: 55,
        timestamp: Date.now() - 49 * 60 * 60 * 1000,
      },
    });

    expect(imported).toBe(0);
    expect(getCachedPriceState("ash_prime_set")).toBeNull();
  });

  it("replaces older in-memory entries during snapshot import", () => {
    setCachedPrice("ash_prime_set", 40);
    vi.advanceTimersByTime(1_000);

    const imported = importCache({
      ash_prime_set: {
        status: "ok",
        median: 55,
        timestamp: Date.now(),
      },
    });

    expect(imported).toBe(1);
    expect(getCachedPriceState("ash_prime_set")?.median).toBe(55);
  });
});
