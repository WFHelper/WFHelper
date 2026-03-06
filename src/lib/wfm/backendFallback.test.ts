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
            datetime: "2026-01-01T00:00:00.000Z",
            median,
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
            datetime: "2026-01-01T00:00:00.000Z",
            median: rank0Median,
            mod_rank: 0,
          },
          {
            order_type: "sell",
            datetime: "2026-01-01T01:00:00.000Z",
            median: rankMaxMedian,
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
});

afterEach(() => {
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
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
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

    const { fetchPriceBySlug } = await import("./wfmPrice.js");
    const result = await fetchPriceBySlug("primed_flow", { priority: "normal", rank: 10 });

    expect(result).toMatchObject({ status: "ok", slug: "primed_flow", median: 155 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(`${BACKEND_URL}/v1/prices/primed_flow?rank=10`);
    expect(toUrl(fetchMock.mock.calls[1][0])).toBe(
      "https://api.warframe.market/v1/items/primed_flow/statistics",
    );
  });

  it("does not truncate backend order rows to ten entries", async () => {
    const sellRows = Array.from({ length: 25 }, (_, index) => ({
      userName: `seller_${index}`,
      status: "offline",
      platinum: 100 + index,
      quantity: 1,
      rank: 0,
    }));

    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/orders/primed_animal_instinct?rank=0`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            slug: "primed_animal_instinct",
            sell: sellRows,
            buy: [],
            timestamp: 778899,
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchItemOrderBookBySlug, clearOrderBookCache } = await import("./orderBook.js");
    clearOrderBookCache();

    const result = await fetchItemOrderBookBySlug("primed_animal_instinct", { rank: 0 });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.sell).toHaveLength(25);
      expect(result.data.sell[0]).toMatchObject({ userName: "seller_0", rank: 0 });
      expect(result.data.sell[24]).toMatchObject({ userName: "seller_24", rank: 0 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUrl(fetchMock.mock.calls[0][0])).toBe(
      `${BACKEND_URL}/v1/orders/primed_animal_instinct?rank=0`,
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
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { fetchWfmItemMetaBySlug } = await import("./wfmItemMeta.js");
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

    const { fetchWfmItemMetaBySlug } = await import("./wfmItemMeta.js");
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

    const { fetchWfmItemMetaBySlug } = await import("./wfmItemMeta.js");
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
});
