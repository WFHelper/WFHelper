import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestV2, WfmApiError } from "../../services/wfmClient";
import * as wfmOrders from "../../services/wfmOrders";

vi.mock("../../services/wfmClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/wfmClient")>();
  return { ...actual, requestV2: vi.fn() };
});

const requestV2Mock = vi.mocked(requestV2);

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
      .mockRejectedValueOnce(perTradeError("notAllowed"))
      .mockResolvedValueOnce(ORDER_RESPONSE);

    await wfmOrders.createOrder({ itemId: "i1", orderType: "sell", platinum: 85, quantity: 1 });

    expect(requestV2Mock).toHaveBeenCalledTimes(2);
    const retryBody = requestV2Mock.mock.calls[1][2]?.json as Record<string, unknown>;
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
});
