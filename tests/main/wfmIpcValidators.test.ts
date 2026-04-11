import { describe, expect, it } from "vitest";

import { __test__ } from "../../ipc/wfmIpc";

describe("wfmIpc payload validators", () => {
  it("accepts valid sign-in payload", () => {
    const parsed = __test__.parseCredentials({
      email: " user@example.com ",
      password: "secret",
    });

    expect(parsed).toEqual({
      email: "user@example.com",
      password: "secret",
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

  it("accepts valid close-order payload", () => {
    const parsed = __test__.parseCloseOrderPayload({
      orderId: "54a74454e779892d5e5155d0",
      quantity: 1,
    });
    expect(parsed).toEqual({ orderId: "54a74454e779892d5e5155d0", quantity: 1 });
  });

  it("rejects close-order with bad orderId", () => {
    expect(__test__.parseCloseOrderPayload({ orderId: "bad-id", quantity: 1 })).toBeNull();
    expect(__test__.parseCloseOrderPayload({ orderId: "", quantity: 1 })).toBeNull();
    expect(__test__.parseCloseOrderPayload({ orderId: 12345, quantity: 1 })).toBeNull();
  });

  it("rejects close-order with invalid quantity", () => {
    expect(
      __test__.parseCloseOrderPayload({ orderId: "54a74454e779892d5e5155d0", quantity: 0 }),
    ).toBeNull();
    expect(
      __test__.parseCloseOrderPayload({ orderId: "54a74454e779892d5e5155d0", quantity: -1 }),
    ).toBeNull();
    expect(
      __test__.parseCloseOrderPayload({ orderId: "54a74454e779892d5e5155d0", quantity: "abc" }),
    ).toBeNull();
  });
});
