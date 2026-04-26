import { describe, expect, it } from "vitest";

import { hasInventoryShape, unwrapInventoryPayload } from "../../config/shared/inventoryPayload";

describe("main inventory payload helper", () => {
  it("detects inventory-like payloads", () => {
    expect(hasInventoryShape({ Suits: [] })).toBe(true);
    expect(hasInventoryShape({ Upgrades: [] })).toBe(true);
    expect(hasInventoryShape({})).toBe(false);
  });

  it("unwraps nested object payload envelopes", () => {
    const raw = {
      payload: {
        data: {
          Suits: [{ ItemType: "A" }],
          Upgrades: [],
        },
      },
    };

    const unwrapped = unwrapInventoryPayload(raw) as any;
    expect(Array.isArray(unwrapped.Suits)).toBe(true);
    expect(unwrapped.Suits[0].ItemType).toBe("A");
  });

  it("unwraps nested JSON strings", () => {
    const raw = {
      inventory_json: JSON.stringify({
        LevelKeys: [{ ItemType: "RelicX" }],
      }),
    };

    const unwrapped = unwrapInventoryPayload(raw) as any;
    expect(Array.isArray(unwrapped.LevelKeys)).toBe(true);
    expect(unwrapped.LevelKeys[0].ItemType).toBe("RelicX");
  });
});
