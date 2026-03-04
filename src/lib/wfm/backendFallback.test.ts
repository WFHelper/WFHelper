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

  it("falls back to direct price API when backend misses", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/prices/burston_prime_receiver`) {
        return new Response("", { status: 404 });
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

  it("falls back to direct meta API when backend misses", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url = toUrl(input);
      if (url === `${BACKEND_URL}/v1/meta/soma_prime_receiver`) {
        return new Response("", { status: 404 });
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
