import { describe, expect, it } from "vitest";

import { extractWfmErrorDetail } from "../../services/wfmClient";

describe("extractWfmErrorDetail", () => {
  it("surfaces nested v2 field errors (the perTrade-required 400)", () => {
    const body = {
      apiVersion: "0.25.0",
      data: null,
      error: { inputs: { perTrade: "app.field.required" } },
    };
    expect(extractWfmErrorDetail(body)).toBe("perTrade: app.field.required");
  });

  it("handles a plain string error", () => {
    expect(extractWfmErrorDetail({ error: "Item not found" })).toBe("Item not found");
  });

  it("handles error.message and top-level message", () => {
    expect(extractWfmErrorDetail({ error: { message: "boom" } })).toBe("boom");
    expect(extractWfmErrorDetail({ message: "nope" })).toBe("nope");
  });

  it("returns null for non-object / empty bodies", () => {
    expect(extractWfmErrorDetail("HTTP 400")).toBeNull();
    expect(extractWfmErrorDetail({})).toBeNull();
  });
});
