import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOrderBookCache,
  fetchItemOrderBookBySlug,
  resetOrderBookDebugCounters,
} from "./orderBook.js";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

beforeEach(() => {
  clearOrderBookCache();
  resetOrderBookDebugCounters();
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchItemOrderBookBySlug", () => {
  it("returns error for invalid slug input", async () => {
    const result = await fetchItemOrderBookBySlug("   ");

    expect(result).toEqual({ status: "error", slug: "" });
  });

  it("caches successful results", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.warframe.market/v2/orders/item/ash_prime_set") {
        return jsonResponse(200, {
          data: [
            {
              type: "sell",
              platinum: 90,
              quantity: 1,
              visible: true,
              user: { ingameName: "seller-a", status: "ingame" },
            },
            {
              type: "buy",
              platinum: 80,
              quantity: 2,
              visible: true,
              user: { ingameName: "buyer-a", status: "online" },
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await fetchItemOrderBookBySlug("Ash Prime Set");
    const second = await fetchItemOrderBookBySlug("ash_prime_set");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates in-flight requests for the same slug", async () => {
    let resolveRequest: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });

    const fetchMock = vi.fn(async () => pending);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const requestA = fetchItemOrderBookBySlug("burston_prime_receiver");
    const requestB = fetchItemOrderBookBySlug("burston_prime_receiver");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveRequest(
      jsonResponse(200, {
        data: [
          {
            type: "sell",
            platinum: 20,
            quantity: 1,
            visible: true,
            user: { ingameName: "seller-b", status: "online" },
          },
        ],
      }),
    );

    const [resultA, resultB] = await Promise.all([requestA, requestB]);

    expect(resultA).toEqual(resultB);
  });

  it("caches not_found responses", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await fetchItemOrderBookBySlug("soma_prime_receiver");
    const second = await fetchItemOrderBookBySlug("soma_prime_receiver");

    expect(first).toEqual({ status: "not_found", slug: "soma_prime_receiver" });
    expect(second).toEqual({ status: "not_found", slug: "soma_prime_receiver" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps rank-filtered cache entries separate", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            type: "sell",
            platinum: 25,
            quantity: 1,
            rank: 0,
            visible: true,
            user: { ingameName: "seller-r0", status: "online" },
          },
          {
            type: "sell",
            platinum: 120,
            quantity: 1,
            rank: 10,
            visible: true,
            user: { ingameName: "seller-r10", status: "online" },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rank0 = await fetchItemOrderBookBySlug("primed_flow", { rank: 0 });
    const rank10 = await fetchItemOrderBookBySlug("primed_flow", { rank: 10 });

    expect(rank0.status).toBe("ok");
    expect(rank10.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to v1 orders endpoint when v2 endpoint is unavailable", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.warframe.market/v2/orders/item/primed_flow") {
        return new Response("", { status: 403 });
      }
      if (url === "https://api.warframe.market/v1/items/primed_flow/orders") {
        return jsonResponse(200, {
          payload: {
            orders: [
              {
                order_type: "sell",
                platinum: 120,
                quantity: 1,
                visible: true,
                user: { ingame_name: "seller-r10", status: "online" },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchItemOrderBookBySlug("primed_flow", { rank: 10 });

    expect(result.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
