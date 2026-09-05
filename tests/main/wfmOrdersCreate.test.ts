import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestV2, WfmApiError } from "../../services/wfmClient";
import * as wfmCatalog from "../../services/wfmCatalog";
import * as wfmOrders from "../../services/wfmOrders";
import { normalizeSubtype, subtypeChoicesOf } from "../../config/shared/wfmOrders";
import * as wfmSession from "../../services/wfmSession";

vi.mock("../../services/wfmClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/wfmClient")>();
  return { ...actual, requestV2: vi.fn() };
});

vi.mock("../../services/wfmSession", () => ({
  getInGameName: vi.fn(),
}));

vi.mock("../../services/wfmCatalog", () => ({
  lookupById: vi.fn(),
}));

const requestV2Mock = vi.mocked(requestV2);
const getInGameNameMock = vi.mocked(wfmSession.getInGameName);
const lookupByIdMock = vi.mocked(wfmCatalog.lookupById);

const ORDER_RESPONSE = {
  data: { order: { id: "o1", type: "sell", platinum: 85, quantity: 1, visible: true } },
};

function perTradeError(kind: "notAllowed" | "required"): WfmApiError {
  return new WfmApiError(
    `WFMClient v2 API error: perTrade: app.field.${kind}`,
    "WFM_API_ERROR",
    400,
  );
}

describe("createOrder perTrade adaptivity", () => {
  beforeEach(() => {
    requestV2Mock.mockReset();
    wfmOrders.__resetWfmOrdersForTest();
  });

  it("omits perTrade by default (api 0.25 rejects it)", async () => {
    requestV2Mock.mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 });

    expect(requestV2Mock).toHaveBeenCalledTimes(1);
    const body = requestV2Mock.mock.calls[0][2]?.json as Record<string, unknown>;
    expect(body).not.toHaveProperty("perTrade");
  });

  it("retries with perTrade when the server says app.field.required, then remembers", async () => {
    requestV2Mock
      .mockRejectedValueOnce(perTradeError("required"))
      .mockResolvedValueOnce(ORDER_RESPONSE)
      .mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 3 });

    expect(requestV2Mock).toHaveBeenCalledTimes(2);
    const retryBody = requestV2Mock.mock.calls[1][2]?.json as Record<string, unknown>;
    expect(retryBody.perTrade).toBe(1);

    // Mode is cached: the next create sends perTrade on the first attempt.
    await wfmOrders.createOrder({ itemId: "i2", orderType: "sell", platinum: 10, quantity: 2 });
    const nextBody = requestV2Mock.mock.calls[2][2]?.json as Record<string, unknown>;
    expect(nextBody.perTrade).toBe(1);
  });

  it("flips back to omitting when a perTrade-sending create hits app.field.notAllowed", async () => {
    requestV2Mock
      .mockRejectedValueOnce(perTradeError("required"))
      .mockResolvedValueOnce(ORDER_RESPONSE)
      .mockRejectedValueOnce(perTradeError("notAllowed"))
      .mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i0", orderType: "sell", platinum: 10, quantity: 1 });
    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 });

    expect(requestV2Mock).toHaveBeenCalledTimes(4);
    const retryBody = requestV2Mock.mock.calls[3][2]?.json as Record<string, unknown>;
    expect(retryBody).not.toHaveProperty("perTrade");
  });

  it("does not retry on unrelated errors", async () => {
    requestV2Mock.mockRejectedValueOnce(
      new WfmApiError("WFMClient v2 API error: platinum: app.field.invalid", "WFM_API_ERROR", 400),
    );

    await expect(
      wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: -1, quantity: 1 }),
    ).rejects.toThrow(/platinum/);
    expect(requestV2Mock).toHaveBeenCalledTimes(1);
  });

  it("retries with rank 0 when the server requires rank and none was given", async () => {
    requestV2Mock
      .mockRejectedValueOnce(
        new WfmApiError("WFMClient v2 API error: rank: app.field.required", "WFM_API_ERROR", 400),
      )
      .mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 });

    expect(requestV2Mock).toHaveBeenCalledTimes(2);
    const retryBody = requestV2Mock.mock.calls[1][2]?.json as Record<string, unknown>;
    expect(retryBody.rank).toBe(0);
  });

  it("does not rank-retry when a rank was already sent", async () => {
    requestV2Mock.mockRejectedValueOnce(
      new WfmApiError("WFMClient v2 API error: rank: app.field.required", "WFM_API_ERROR", 400),
    );

    await expect(
      wfmOrders.createOrder({
        itemId: "i1",
        orderType: "sell",
        platinum: 85,
        quantity: 1,
        modRank: 3,
      }),
    ).rejects.toThrow(/rank/);
    expect(requestV2Mock).toHaveBeenCalledTimes(1);
  });

  it("recovers both calls when two concurrent first creates race the flag", async () => {
    requestV2Mock.mockImplementation(async (_method, _path, opts) => {
      const body = (opts?.json ?? {}) as Record<string, unknown>;
      if (!("perTrade" in body)) throw perTradeError("required");
      return ORDER_RESPONSE;
    });

    const [a, b] = await Promise.all([
      wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 }),
      wfmOrders.createOrder({ itemId: "i2", orderType: "sell", platinum: 10, quantity: 2 }),
    ]);

    expect(a.id).toBe("o1");
    expect(b.id).toBe("o1");
    expect(requestV2Mock).toHaveBeenCalledTimes(4);
    const bodies = requestV2Mock.mock.calls.map((call) => call[2]?.json as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty("perTrade");
    expect(bodies[1]).not.toHaveProperty("perTrade");
    expect(bodies[2]).toHaveProperty("perTrade");
    expect(bodies[3]).toHaveProperty("perTrade");
  });

  it("applies perTrade and rank fixes across successive retries", async () => {
    requestV2Mock
      .mockRejectedValueOnce(perTradeError("required"))
      .mockRejectedValueOnce(
        new WfmApiError("WFMClient v2 API error: rank: app.field.required", "WFM_API_ERROR", 400),
      )
      .mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 });

    expect(requestV2Mock).toHaveBeenCalledTimes(3);
    const finalBody = requestV2Mock.mock.calls[2][2]?.json as Record<string, unknown>;
    expect(finalBody.perTrade).toBe(1);
    expect(finalBody.rank).toBe(0);
  });
});

// Atragraph variants gave plain mods a subtypes list; v2 then requires one.
describe("createOrder subtype adaptivity", () => {
  const catalogEntry = {
    id: "i1",
    url_name: "vitality",
    item_name: "Vitality",
    thumb: null,
    icon: null,
    maxRank: 10,
    gameRef: null,
  };

  function subtypeError(): WfmApiError {
    return new WfmApiError(
      "WFMClient v2 API error: subtype: app.field.required",
      "WFM_API_ERROR",
      400,
    );
  }

  beforeEach(() => {
    requestV2Mock.mockReset();
    lookupByIdMock.mockReset();
    wfmOrders.__resetWfmOrdersForTest();
  });

  it("fetches the item's subtypes and retries with regular", async () => {
    lookupByIdMock.mockResolvedValueOnce(catalogEntry);
    requestV2Mock.mockImplementation(async (method, _path, opts) => {
      if (method === "GET") return { data: { subtypes: ["regular", "atragraph"] } };
      const body = (opts?.json ?? {}) as Record<string, unknown>;
      if (!("subtype" in body)) throw subtypeError();
      return ORDER_RESPONSE;
    });

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 5, quantity: 1 });

    const calls = requestV2Mock.mock.calls;
    const gets = calls.filter((call) => call[0] === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0][1]).toBe("/item/vitality");
    const finalBody = calls[calls.length - 1][2]?.json as Record<string, unknown>;
    expect(finalBody.subtype).toBe("regular");
  });

  it("refuses to guess a variant when regular is absent and creates nothing", async () => {
    lookupByIdMock.mockResolvedValueOnce(catalogEntry);
    requestV2Mock.mockImplementation(async (method, _path, opts) => {
      if (method === "GET") return { data: { subtypes: ["intact", "radiant"] } };
      const body = (opts?.json ?? {}) as Record<string, unknown>;
      if (!("subtype" in body)) throw subtypeError();
      return ORDER_RESPONSE;
    });

    const attempt = wfmOrders.createOrder({
      itemId: "i1",
      orderType: "sell",
      platinum: 5,
      quantity: 1,
    });
    await expect(attempt).rejects.toMatchObject({
      code: "subtype_required",
      subtypes: ["intact", "radiant"],
    });

    const posts = requestV2Mock.mock.calls.filter((call) => call[0] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][2]?.json).not.toHaveProperty("subtype");
  });

  it("exposes the choices structurally, so a late-required caller can read them", async () => {
    lookupByIdMock.mockResolvedValueOnce(catalogEntry);
    requestV2Mock.mockImplementation(async (method) => {
      if (method === "GET") return { data: { subtypes: ["intact", "radiant"] } };
      throw subtypeError();
    });

    const err = await wfmOrders
      .createOrder({ itemId: "i1", orderType: "sell", platinum: 5, quantity: 1 })
      .catch((e: unknown) => e);
    expect(subtypeChoicesOf(err)).toEqual(["intact", "radiant"]);
    expect(subtypeChoicesOf(new Error("nope"))).toBeNull();
  });

  it("keeps a caller-supplied subtype instead of asking the API", async () => {
    requestV2Mock.mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({
      itemId: "i1",
      orderType: "sell",
      platinum: 5,
      quantity: 1,
      subtype: "radiant",
    });

    const body = requestV2Mock.mock.calls[0][2]?.json as Record<string, unknown>;
    expect(body.subtype).toBe("radiant");
    expect(lookupByIdMock).not.toHaveBeenCalled();
  });

  it("does not subtype-retry when a subtype was already sent", async () => {
    requestV2Mock.mockRejectedValueOnce(subtypeError());

    await expect(
      wfmOrders.createOrder({
        itemId: "i1",
        orderType: "sell",
        platinum: 5,
        quantity: 1,
        subtype: "radiant",
      }),
    ).rejects.toThrow(/subtype/);
    expect(requestV2Mock).toHaveBeenCalledTimes(1);
    expect(lookupByIdMock).not.toHaveBeenCalled();
  });

  it("rethrows when the item reports no subtypes", async () => {
    lookupByIdMock.mockResolvedValueOnce(catalogEntry);
    requestV2Mock.mockImplementation(async (method) => {
      if (method === "GET") return { data: { subtypes: [] } };
      throw subtypeError();
    });

    await expect(
      wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 5, quantity: 1 }),
    ).rejects.toThrow(/subtype/);
  });
});

describe("getMyOrders normalization", () => {
  beforeEach(() => {
    requestV2Mock.mockReset();
    getInGameNameMock.mockReturnValue("TestUser");
  });

  it("preserves the listing perTrade bundle", async () => {
    requestV2Mock.mockResolvedValue({
      data: [
        {
          id: "bundle-order",
          type: "sell",
          platinum: 5,
          quantity: 12,
          perTrade: 6,
          visible: true,
          item: { item_name: "Vitus Essence", url_name: "vitus_essence" },
        },
      ],
    });

    await expect(wfmOrders.getMyOrders()).resolves.toMatchObject({
      sell: [{ id: "bundle-order", quantity: 12, perTrade: 6 }],
      buy: [],
    });
  });
});

describe("normalizeSubtype", () => {
  it("maps the unset default and its spellings to null", () => {
    expect(normalizeSubtype(null)).toBeNull();
    expect(normalizeSubtype(undefined)).toBeNull();
    expect(normalizeSubtype("")).toBeNull();
    expect(normalizeSubtype("  ")).toBeNull();
    expect(normalizeSubtype("regular")).toBeNull();
    expect(normalizeSubtype(" Regular ")).toBeNull();
  });

  it("lowercases and trims every other subtype", () => {
    expect(normalizeSubtype("Radiant")).toBe("radiant");
    expect(normalizeSubtype(" intact ")).toBe("intact");
  });
});
