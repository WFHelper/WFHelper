import { beforeEach, describe, expect, it, vi } from "vitest";

import { WFM_CLOSE_ORDER } from "../../config/shared/ipcChannels";
import { assertMainRendererSender } from "../../ipc/ipcSecurity";
import { __test__, register } from "../../ipc/wfmIpc";

const mocks = vi.hoisted(() => ({ handleAuthorized: vi.fn(), closeOrder: vi.fn() }));
vi.mock("../../ipc/ipcSecurity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/ipcSecurity")>()),
  handleAuthorized: mocks.handleAuthorized,
}));
vi.mock("../../services/wfmOrders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/wfmOrders")>()),
  closeOrder: mocks.closeOrder,
}));

describe("wfmIpc payload validators", () => {
  it("accepts valid sign-in payload", () => {
    const parsed = __test__.parseCredentials({
      email: " user@example.com ",
      password: " secret ",
    });

    expect(parsed).toEqual({
      email: "user@example.com",
      password: " secret ",
    });
  });

  it("rejects malformed create-order payload", () => {
    const parsed = __test__.parseCreateOrderParams({
      itemId: "bad-id",
      orderType: "sell",
      platinum: 10,
      quantity: 1,
    });

    expect(parsed).toBeNull();
  });

  it("accepts supported relic and mod variants and rejects unknown subtypes", () => {
    const base = {
      itemId: "a".repeat(24),
      orderType: "sell",
      platinum: 10,
      quantity: 1,
    };

    expect(__test__.parseCreateOrderParams({ ...base, subtype: "Radiant" })).toMatchObject({
      subtype: "radiant",
    });
    expect(__test__.parseCreateOrderParams({ ...base, subtype: "shiny" })).toBeNull();
    for (const subtype of ["regular", "atragraph"]) {
      expect(__test__.parseCreateOrderParams({ ...base, subtype, modRank: 10 })).toMatchObject({
        subtype,
        modRank: 10,
      });
      expect(
        __test__.parseUpdateOrderPayload({
          orderId: base.itemId,
          updates: { subtype, modRank: 10 },
        })?.updates,
      ).toEqual({ subtype, modRank: 10 });
    }
    // Absent subtype stays absent instead of defaulting.
    expect(__test__.parseCreateOrderParams(base)).not.toHaveProperty("subtype");

    const update = __test__.parseUpdateOrderPayload({
      orderId: "a".repeat(24),
      updates: { subtype: "flawless" },
    });
    expect(update?.updates).toEqual({ subtype: "flawless" });
    expect(
      __test__.parseUpdateOrderPayload({ orderId: "a".repeat(24), updates: { subtype: "x" } }),
    ).toBeNull();
  });

  it("clamps search payload bounds and rejects invalid limits", () => {
    const ok = __test__.parseSearchPayload({ query: "soma", limit: 20 });
    const bad = __test__.parseSearchPayload({ query: "soma", limit: 1000 });

    expect(ok).toEqual({ query: "soma", limit: 20 });
    expect(bad).toBeNull();
  });

  it("accepts only supported status values", () => {
    expect(__test__.parseStatusPayload({ status: "online" })).toEqual({ status: "online" });
    expect(__test__.parseStatusPayload({ status: "offline" })).toBeNull();
  });

  it("parses contracts query with sane defaults and bounds", () => {
    expect(__test__.parseContractsPayload(null)).toEqual({ page: 1, limit: 40 });
    expect(__test__.parseContractsPayload({ page: 3, limit: 60 })).toEqual({
      page: 3,
      limit: 60,
    });
    expect(__test__.parseContractsPayload({ page: 0, limit: 20 })).toBeNull();
    expect(__test__.parseContractsPayload({ page: 2, limit: 1000 })).toBeNull();
  });
});

describe("wfm:close-order handler", () => {
  const orderId = "a".repeat(24);
  let guard: unknown;
  let closeHandler: (event: unknown, payload: unknown) => Promise<unknown>;

  beforeEach(() => {
    mocks.handleAuthorized.mockClear();
    mocks.closeOrder.mockReset();
    register();
    const call = mocks.handleAuthorized.mock.calls.find(([channel]) => channel === WFM_CLOSE_ORDER);
    [, guard, closeHandler] = call!;
  });

  it("is guarded to the main renderer and closes the requested quantity", async () => {
    mocks.closeOrder.mockResolvedValue({ closed: true, id: orderId, remainingQuantity: 0 });

    expect(guard).toBe(assertMainRendererSender);
    // A bulk listing closes a whole trade; WFM itself enforces the perTrade multiple.
    await expect(closeHandler({}, { orderId, quantity: 6 })).resolves.toEqual({
      closed: true,
      id: orderId,
    });
    expect(mocks.closeOrder).toHaveBeenCalledWith(orderId, 6);
  });

  it("rejects a malformed order id or quantity without calling WFM", async () => {
    for (const payload of [
      null,
      "x",
      {},
      { orderId: "not-an-id", quantity: 1 },
      { orderId: "a".repeat(25), quantity: 1 },
      { orderId },
      { orderId, quantity: 0 },
      { orderId, quantity: -6 },
      { orderId, quantity: 1.5 },
      { orderId, quantity: "6" },
      { orderId, quantity: Number.NaN },
      { orderId, quantity: 100_000 },
    ]) {
      await expect(closeHandler({}, payload)).resolves.toEqual({
        error: "Invalid close-order payload.",
      });
    }
    expect(mocks.closeOrder).not.toHaveBeenCalled();
  });

  it("returns a WFM failure as an error instead of throwing", async () => {
    mocks.closeOrder.mockRejectedValue(new Error("Order not found"));

    await expect(closeHandler({}, { orderId, quantity: 1 })).resolves.toEqual({
      error: "Order not found",
    });
  });
});
