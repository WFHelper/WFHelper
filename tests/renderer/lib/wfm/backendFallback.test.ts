import { WFM_PRICE_BASIS } from "../../../../config/shared/wfmStats.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BACKEND_URL = "https://backend.test";
const originalFetch = globalThis.fetch;

function toUrl(input: Request | URL | string): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function statsPayload(median: number): Record<string, unknown> {
  return {
    payload: {
      statistics_closed: {
        "48hours": [
          {
            order_type: "sell",
            datetime: new Date().toISOString(),
            wa_price: median,
            volume: 1,
          },
        ],
      },
    },
  };
}

function rankedStatsPayload(rank0Median: number, rankMaxMedian: number): Record<string, unknown> {
  return {
    payload: {
      statistics_closed: {
        "48hours": [
          {
            order_type: "sell",
            datetime: new Date().toISOString(),
            wa_price: rank0Median,
            volume: 1,
            mod_rank: 0,
          },
          {
            order_type: "sell",
            datetime: new Date().toISOString(),
            wa_price: rankMaxMedian,
            volume: 1,
            mod_rank: 10,
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubEnv("VITE_WFM_BACKEND_URL", BACKEND_URL);
  vi.stubEnv("VITE_WFM_BACKEND_DIRECT_FALLBACK", "always");
  vi.stubEnv("VITE_WFM_BACKEND_BOOTSTRAP_ENABLED", ""); // disable bootstrap in tests
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("WFM backend fallback integration", () => {
  it("uses backend price when cache backend has data", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/ash_prime_blueprint`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "ash_prime_blueprint",
            median: 77,
            timestamp: 123456789,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("ash_prime_blueprint", { priority: "normal" });

    expect(result).toMatchObject({
      status: "ok",
      slug: "ash_prime_blueprint",
      median: 77,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/ash_prime_blueprint`);
  });

  it("does not fall back to direct price API when backend returns not_found", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/burston_prime_receiver`) {
        return new Response("", { status: 404 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("burston_prime_receiver", { priority: "normal" });

    expect(result).toMatchObject({
      status: "no_data",
      slug: "burston_prime_receiver",
      median: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(
      `${BACKEND_URL}/v1/prices/burston_prime_receiver`,
    );
  });

  it("can bypass cached no_data when ignoreNoDataCache is enabled", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/quickdraw`) {
        if (fetchMock.mock.calls.length === 1) {
          return new Response("", { status: 404 });
        }

        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "quickdraw",
            median: 4,
            timestamp: 223355,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const first = await fetchPriceBySlug("quickdraw", { priority: "normal" });
    const second = await fetchPriceBySlug("quickdraw", {
      priority: "normal",
      ignoreNoDataCache: true,
    });

    expect(first).toMatchObject({ status: "no_data", slug: "quickdraw", median: null });
    expect(second).toMatchObject({ status: "ok", slug: "quickdraw", median: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/quickdraw`);
    expect(toUrl(fetchMock.mock.calls[1][0])).toBe(`${BACKEND_URL}/v1/prices/quickdraw`);
  });

  it("falls back to direct price API when backend errors", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/burston_prime_receiver`) {
        return new Response("", { status: 503 });
      }

      if (url === "https://api.warframe.market/v1/items/burston_prime_receiver/statistics") {
        return jsonResponse(200, statsPayload(19));
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("burston_prime_receiver", { priority: "normal" });

    expect(result).toMatchObject({
      status: "ok",
      slug: "burston_prime_receiver",
      median: 19,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(
      `${BACKEND_URL}/v1/prices/burston_prime_receiver`,
    );
    expect(toUrl(fetchMock.mock.calls[1][0])).toBe(
      "https://api.warframe.market/v1/items/burston_prime_receiver/statistics",
    );
  });

  it("releases the price queue after a direct fallback timeout", async () => {
    vi.useFakeTimers();
    let directCalls = 0;
    const fetchMock = vi.fn((input: Request | URL | string, init?: Parameters<typeof fetch>[1]) => {
      const url = toUrl(input);
      if (url.startsWith(`${BACKEND_URL}/v1/prices/`)) {
        return Promise.resolve(new Response("", { status: 503 }));
      }
      if (url.startsWith("https://api.warframe.market/v1/items/")) {
        directCalls += 1;
        if (directCalls === 2) return Promise.resolve(jsonResponse(200, statsPayload(25)));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");

    const stalled = fetchPriceBySlug("stalled_item", { priority: "normal" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stalled).resolves.toMatchObject({ status: "transient" });

    await expect(fetchPriceBySlug("recovered_item", { priority: "normal" })).resolves.toMatchObject(
      { status: "ok", median: 25 },
    );
    expect(directCalls).toBe(2);
  });

  it("supports rank-aware backend price requests", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/primed_flow?rank=10`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "primed_flow",
            rank: 10,
            median: 150,
            timestamp: 223344,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("primed_flow", { priority: "normal", rank: 10 });

    expect(result).toMatchObject({ status: "ok", slug: "primed_flow", median: 150 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/primed_flow?rank=10`);
  });

  it("normalizes numeric string rank for backend price requests", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/primed_flow?rank=10`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "primed_flow",
            rank: 10,
            median: 150,
            timestamp: 223344,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("primed_flow", {
      priority: "normal",
      rank: "10" as unknown as number,
    });

    expect(result).toMatchObject({ status: "ok", slug: "primed_flow", median: 150 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/primed_flow?rank=10`);
  });

  it("supports rank-aware direct fallback when backend errors", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/primed_flow?rank=10`) {
        return new Response("", { status: 503 });
      }

      if (url === "https://api.warframe.market/v1/items/primed_flow/statistics") {
        return jsonResponse(200, rankedStatsPayload(60, 155));
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const result = await fetchPriceBySlug("primed_flow", { priority: "normal", rank: 10 });

    expect(result).toMatchObject({ status: "ok", slug: "primed_flow", median: 155 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/primed_flow?rank=10`);
    expect(toUrl(fetchMock.mock.calls[1][0])).toBe(
      "https://api.warframe.market/v1/items/primed_flow/statistics",
    );
  });

  it("single-flights bootstrap token fetches across parallel backend requests", async () => {
    vi.stubEnv("VITE_WFM_BACKEND_BOOTSTRAP_ENABLED", "1");
    vi.stubEnv("VITE_WFM_BACKEND_DIRECT_FALLBACK", "never");
    vi.resetModules();

    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/bootstrap`) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return jsonResponse(200, {
          ok: true,
          data: {
            token: "bootstrap-token",
            expiresAt: Date.now() + 300_000,
          },
        });
      }

      if (url.startsWith(`${BACKEND_URL}/v1/prices/bootstrap_test_`)) {
        return new Response("", { status: 404 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("../../../../src/lib/wfm/wfmPrice.js");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fetchPriceBySlug(`bootstrap_test_${index}`, { priority: "normal" }),
      ),
    );

    expect(results.every((result) => result.status === "no_data")).toBe(true);
    expect(
      fetchMock.mock.calls.filter((call) => toUrl(call[0]) === `${BACKEND_URL}/v1/bootstrap`),
    ).toHaveLength(1);
  });

  it("drops renderer price fetches when the queue is full", async () => {
    vi.resetModules();

    const { __test__, getPriceDebugCountersForTest } =
      await import("../../../../src/lib/wfm/wfmPrice.js");
    for (let i = 0; i < 65; i += 1) {
      void __test__.enqueueForTest(() => new Promise(() => {}), "normal").catch(() => {});
    }

    await expect(__test__.enqueueForTest(() => Promise.resolve("ok"), "normal")).rejects.toThrow(
      __test__.priceQueueFullError,
    );
    expect(getPriceDebugCountersForTest().queueDropped).toBe(1);
  });

  it("uses backend order summary route for ranked card summaries", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/order-summary/primed_flow?rank=10`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "primed_flow",
            rank: 10,
            wts: 150,
            wtb: 120,
            timestamp: 112233,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchOrderSummaryBySlug, resetOrderSummaryDebugState } =
      await import("../../../../src/lib/wfm/orderSummaryRemote.js");
    resetOrderSummaryDebugState();

    const result = await fetchOrderSummaryBySlug("primed_flow", { rank: 10 });

    expect(result).toMatchObject({
      status: "ok",
      data: {
        slug: "primed_flow",
        rank: 10,
        wts: 150,
        wtb: 120,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(
      `${BACKEND_URL}/v1/order-summary/primed_flow?rank=10`,
    );
  });

  it("uses backend meta when backend has data", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/meta/ash_prime_set`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "ash_prime_set",
            ducats: 100,
            setRoot: true,
            thumb: "icons/ash-thumb.png",
            icon: "icons/ash-icon.png",
            timestamp: 111,
            priceBasis: WFM_PRICE_BASIS,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchWfmItemMetaBySlug } = await import("../../../../src/lib/wfm/wfmItemMeta.js");
    const result = await fetchWfmItemMetaBySlug("ash_prime_set", { priority: "normal" });

    expect(result).toMatchObject({
      slug: "ash_prime_set",
      ducats: 100,
      setRoot: true,
      thumb: "https://warframe.market/static/assets/icons/ash-thumb.png",
      icon: "https://warframe.market/static/assets/icons/ash-icon.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/meta/ash_prime_set`);
  });

  it("does not fall back to direct meta API when backend returns not_found", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/meta/soma_prime_receiver`) {
        return new Response("", { status: 404 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchWfmItemMetaBySlug } = await import("../../../../src/lib/wfm/wfmItemMeta.js");
    const result = await fetchWfmItemMetaBySlug("soma_prime_receiver", { priority: "normal" });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/meta/soma_prime_receiver`);
  });

  it("falls back to direct meta API when backend errors", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/meta/soma_prime_receiver`) {
        return new Response("", { status: 503 });
      }

      if (url === "https://api.warframe.market/v2/items/soma_prime_receiver") {
        return jsonResponse(200, {
          data: {
            ducats: 45,
            setRoot: false,
            i18n: {
              en: {
                thumb: "icons/soma-thumb.png",
                icon: "icons/soma-icon.png",
              },
            },
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchWfmItemMetaBySlug } = await import("../../../../src/lib/wfm/wfmItemMeta.js");
    const result = await fetchWfmItemMetaBySlug("soma_prime_receiver", { priority: "normal" });

    expect(result).toMatchObject({
      slug: "soma_prime_receiver",
      ducats: 45,
      setRoot: false,
      thumb: "https://warframe.market/static/assets/icons/soma-thumb.png",
      icon: "https://warframe.market/static/assets/icons/soma-icon.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/meta/soma_prime_receiver`);
    expect(toUrl(fetchMock.mock.calls[1][0])).toBe(
      "https://api.warframe.market/v2/items/soma_prime_receiver",
    );
  });

  it("settles item metadata after a direct fallback timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: Request | URL | string, init?: Parameters<typeof fetch>[1]) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/meta/stalled_item`) {
        return Promise.resolve(new Response("", { status: 503 }));
      }
      if (url === "https://api.warframe.market/v2/items/stalled_item") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { fetchWfmItemMetaBySlug } = await import("../../../../src/lib/wfm/wfmItemMeta.js");

    const request = fetchWfmItemMetaBySlug("stalled_item", { priority: "normal" });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(request).resolves.toBeNull();
  });
});
