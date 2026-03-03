import { describe, expect, it } from "vitest";

const { __test__ } = require("../../ipc/wfmIpc.js");

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
});
