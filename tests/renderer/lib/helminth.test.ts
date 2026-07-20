import { describe, expect, it } from "vitest";

import { buildSubsumedFamilySet, isFrameSubsumed } from "../../../src/lib/helminth.js";
import type { ItemDbLookup } from "../../../src/types/ipc.js";

const NYX = "/Lotus/Powersuits/Jade/Jade";
const itemDb = { [NYX]: { name: "Nyx" } } as unknown as ItemDbLookup;

describe("helminth subsume families", () => {
  it("builds the family set from ConsumedSuits", () => {
    const set = buildSubsumedFamilySet(
      { InfestedFoundry: { ConsumedSuits: [{ s: NYX }] } },
      itemDb,
    );
    expect(set.has("nyx")).toBe(true);
  });

  it("matches the frame, its prime, and its component blueprints", () => {
    const set = new Set(["nyx"]);
    expect(isFrameSubsumed("Nyx", set)).toBe(true);
    expect(isFrameSubsumed("Nyx Prime", set)).toBe(true);
    expect(isFrameSubsumed("Nyx Prime Neuroptics Blueprint", set)).toBe(true);
    expect(isFrameSubsumed("Nyx Systems Blueprint", set)).toBe(true);
    expect(isFrameSubsumed("Rhino Chassis Blueprint", set)).toBe(false);
  });

  it("handles missing InfestedFoundry", () => {
    expect(buildSubsumedFamilySet(null, itemDb).size).toBe(0);
    expect(buildSubsumedFamilySet({}, itemDb).size).toBe(0);
    expect(isFrameSubsumed("Nyx", new Set())).toBe(false);
  });
});
