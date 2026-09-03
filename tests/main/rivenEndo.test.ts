import { describe, expect, it } from "vitest";

import { rivenDissolveEndo, rivenEndoPerPlat } from "../../config/shared/rivenEndo";

describe("rivenDissolveEndo", () => {
  it("matches the community formula 100*(MR-8) + floor(22.5*2^rank) + 200*rerolls - 7", () => {
    expect(rivenDissolveEndo(13, 0, 0)).toBe(515);
    expect(rivenDissolveEndo(8, 0, 0)).toBe(15);
    expect(rivenDissolveEndo(16, 8, 10)).toBe(800 + 5760 + 2000 - 7);
    expect(rivenDissolveEndo(14, 3, 2)).toBe(600 + Math.floor(22.5 * 8) + 400 - 7);
  });

  it("clamps hostile inputs to game ranges", () => {
    expect(rivenDissolveEndo(99, 0, 0)).toBe(rivenDissolveEndo(16, 0, 0));
    expect(rivenDissolveEndo(-5, 0, 0)).toBe(rivenDissolveEndo(8, 0, 0));
    expect(rivenDissolveEndo(8, 99, 0)).toBe(rivenDissolveEndo(8, 8, 0));
    expect(rivenDissolveEndo(8, Number.NaN, Number.POSITIVE_INFINITY)).toBe(
      rivenDissolveEndo(8, 0, 0),
    );
  });

  it("computes endo per plat and refuses non-positive prices", () => {
    expect(rivenEndoPerPlat(13, 0, 0, 100)).toBeCloseTo(5.15);
    expect(rivenEndoPerPlat(13, 0, 0, 0)).toBeNull();
    expect(rivenEndoPerPlat(13, 0, 0, -3)).toBeNull();
    expect(rivenEndoPerPlat(13, 0, 0, Number.NaN)).toBeNull();
  });
});
