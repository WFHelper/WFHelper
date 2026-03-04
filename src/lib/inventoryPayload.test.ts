import { describe, expect, it } from "vitest";

import { unwrapInventoryPayload } from "./inventoryPayload.js";

describe("renderer inventory payload helper", () => {
  it("returns original data when payload is already inventory shaped", () => {
    const data = {
      Suits: [{ ItemType: "Warframe" }],
    };

    const unwrapped = unwrapInventoryPayload(data as never);
    expect(unwrapped.Suits?.[0]?.ItemType).toBe("Warframe");
  });

  it("unwraps payload/data envelopes", () => {
    const data = {
      payload: {
        data: {
          Arcanes: [{ ItemType: "ArcaneTest" }],
        },
      },
    };

    const unwrapped = unwrapInventoryPayload(data as never);
    expect(unwrapped.Arcanes?.[0]?.ItemType).toBe("ArcaneTest");
  });
});
