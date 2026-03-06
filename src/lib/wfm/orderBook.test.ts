import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearOrderBookCache, fetchItemOrderBookBySlug } from "./orderBook.js";
import { fetchBackendOrdersBySlug } from "./backendLite.js";
import type { BackendFetchResult, BackendOrdersPayload } from "./backendLite.js";

vi.mock("./backendLite.js", async () => {
  const actual = await vi.importActual<typeof import("./backendLite.js")>("./backendLite.js");
  return {
    ...actual,
    fetchBackendOrdersBySlug: vi.fn(),
  };
});

const fetchBackendOrdersBySlugMock = vi.mocked(fetchBackendOrdersBySlug);

beforeEach(() => {
  clearOrderBookCache();
  vi.clearAllMocks();
});

describe("fetchItemOrderBookBySlug", () => {
  it("returns error for invalid slug input", async () => {
    const result = await fetchItemOrderBookBySlug("   ");

    expect(result).toEqual({ status: "error", slug: "" });
    expect(fetchBackendOrdersBySlugMock).not.toHaveBeenCalled();
  });

  it("caches successful results", async () => {
    fetchBackendOrdersBySlugMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        slug: "ash_prime_set",
        sell: [{ userName: "seller-a", status: "ingame", platinum: 90, quantity: 1, rank: null }],
        buy: [{ userName: "buyer-a", status: "online", platinum: 80, quantity: 2, rank: null }],
        timestamp: 123,
      },
    });

    const first = await fetchItemOrderBookBySlug("Ash Prime Set");
    const second = await fetchItemOrderBookBySlug("ash_prime_set");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledTimes(1);
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledWith("ash_prime_set", { rank: null });
  });

  it("deduplicates in-flight requests for the same slug", async () => {
    let resolveRequest: (value: BackendFetchResult<BackendOrdersPayload>) => void = () => {};
    const pending = new Promise<BackendFetchResult<BackendOrdersPayload>>((resolve) => {
      resolveRequest = resolve;
    });

    fetchBackendOrdersBySlugMock.mockReturnValueOnce(pending);

    const requestA = fetchItemOrderBookBySlug("burston_prime_receiver");
    const requestB = fetchItemOrderBookBySlug("burston_prime_receiver");

    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledTimes(1);

    resolveRequest({
      status: "ok",
      data: {
        slug: "burston_prime_receiver",
        sell: [{ userName: "seller-b", status: null, platinum: 20, quantity: 1, rank: null }],
        buy: [],
        timestamp: 456,
      },
    });

    const [resultA, resultB] = await Promise.all([requestA, requestB]);

    expect(resultA).toEqual(resultB);
  });

  it("caches not_found responses", async () => {
    fetchBackendOrdersBySlugMock.mockResolvedValueOnce({ status: "not_found" });

    const first = await fetchItemOrderBookBySlug("soma_prime_receiver");
    const second = await fetchItemOrderBookBySlug("soma_prime_receiver");

    expect(first).toEqual({ status: "not_found", slug: "soma_prime_receiver" });
    expect(second).toEqual({ status: "not_found", slug: "soma_prime_receiver" });
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledTimes(1);
  });

  it("keeps rank-filtered cache entries separate", async () => {
    fetchBackendOrdersBySlugMock
      .mockResolvedValueOnce({
        status: "ok",
        data: {
          slug: "primed_flow",
          sell: [{ userName: "seller-r0", status: "online", platinum: 25, quantity: 1, rank: 0 }],
          buy: [],
          timestamp: 100,
        },
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: {
          slug: "primed_flow",
          sell: [
            { userName: "seller-r10", status: "online", platinum: 120, quantity: 1, rank: 10 },
          ],
          buy: [],
          timestamp: 101,
        },
      });

    const rank0 = await fetchItemOrderBookBySlug("primed_flow", { rank: 0 });
    const rank10 = await fetchItemOrderBookBySlug("primed_flow", { rank: 10 });

    expect(rank0.status).toBe("ok");
    expect(rank10.status).toBe("ok");
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledTimes(2);
    expect(fetchBackendOrdersBySlugMock).toHaveBeenNthCalledWith(1, "primed_flow", { rank: 0 });
    expect(fetchBackendOrdersBySlugMock).toHaveBeenNthCalledWith(2, "primed_flow", { rank: 10 });
  });

  it("normalizes numeric string rank filters", async () => {
    fetchBackendOrdersBySlugMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        slug: "primed_flow",
        sell: [{ userName: "seller-r10", status: "online", platinum: 120, quantity: 1, rank: 10 }],
        buy: [],
        timestamp: 101,
      },
    });

    const result = await fetchItemOrderBookBySlug("primed_flow", {
      rank: "10" as unknown as number,
    });

    expect(result.status).toBe("ok");
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledTimes(1);
    expect(fetchBackendOrdersBySlugMock).toHaveBeenCalledWith("primed_flow", { rank: 10 });
  });
});
