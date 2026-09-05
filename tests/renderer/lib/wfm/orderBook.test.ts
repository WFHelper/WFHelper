import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOrderBookCache,
  fetchItemOrderBookBySlug,
  resetOrderBookDebugCounters,
} from "../../../../src/lib/wfm/orderBook.js";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function orderResponse(platinum: number): Response {
  return jsonResponse(200, {
    data: [
      {
        type: "sell",
        platinum,
        quantity: 1,
        visible: true,
        user: { ingameName: "seller", status: "online" },
      },
    ],
  });
}

beforeEach(() => {
  clearOrderBookCache();
  resetOrderBookDebugCounters();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("settles a stalled direct request at the timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_input: Request | URL | string, init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    const request = fetchItemOrderBookBySlug("primed_flow");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(request).resolves.toEqual({ status: "error", slug: "primed_flow" });
  });

  it("keeps a refreshed request owned after the cleared request settles", async () => {
    const oldResponse = deferred<Response>();
    const freshResponse = deferred<Response>();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(freshResponse.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const oldRequest = fetchItemOrderBookBySlug("primed_flow");
    clearOrderBookCache("primed_flow");
    const freshRequest = fetchItemOrderBookBySlug("primed_flow");

    oldResponse.resolve(orderResponse(10));
    await oldRequest;
    const sharedFreshRequest = fetchItemOrderBookBySlug("primed_flow");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    freshResponse.resolve(orderResponse(90));
    const [fresh, shared] = await Promise.all([freshRequest, sharedFreshRequest]);
    expect(fresh).toEqual(shared);
    expect(fresh.status === "ok" ? fresh.data.sell[0]?.platinum : null).toBe(90);

    const cached = await fetchItemOrderBookBySlug("primed_flow");
    expect(cached.status === "ok" ? cached.data.sell[0]?.platinum : null).toBe(90);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("reads a regular subtype as the unnamed default, not as a filter", async () => {
    const fetchMock = vi.fn(async () => orderResponse(90));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const regular = await fetchItemOrderBookBySlug("ash_prime_set", { subtype: "regular" });
    const plain = await fetchItemOrderBookBySlug("ash_prime_set");

    // Subtype-less rows are the whole book here; a "regular" filter would drop
    // them, and both calls have to share the one cache entry.
    expect(regular.status === "ok" ? regular.data.sell.length : 0).toBe(1);
    expect(plain).toEqual(regular);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a refinement subtype filtering the book", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            type: "sell",
            platinum: 12,
            quantity: 1,
            subtype: "radiant",
            visible: true,
            user: { ingameName: "seller-radiant", status: "online" },
          },
          {
            type: "sell",
            platinum: 4,
            quantity: 1,
            subtype: "intact",
            visible: true,
            user: { ingameName: "seller-intact", status: "online" },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const radiant = await fetchItemOrderBookBySlug("axi_a1_relic", { subtype: "Radiant" });

    expect(radiant.status === "ok" ? radiant.data.sell.map((e) => e.userName) : []).toEqual([
      "seller-radiant",
    ]);
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
