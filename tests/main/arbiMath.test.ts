import { describe, expect, it } from "vitest";

import { computeVitusModel, normCdf, scenarioTable } from "../../config/shared/arbiMath";

describe("computeVitusModel", () => {
  it("matches hand-computed values for a typical run", () => {
    // rounds=10, 3 waves/rot, 100 drones:
    // meanVal=2.36, rotMean=13, rotVar=8.1, meanDrops=15, varDrops=12.75, varVal=0.5904
    const m = computeVitusModel(10, 3, 100);
    expect(m.mean).toBeCloseTo(48.4, 6);
    expect(m.std).toBeCloseTo(Math.sqrt(8.1 + 15 * 0.5904 + 2.36 * 2.36 * 12.75), 6);
  });

  it("uses wavesPerRotation for the rotation bonus (mirror defense)", () => {
    const mirror = computeVitusModel(10, 2, 0);
    expect(mirror.mean).toBeCloseTo(10 + 10 * 0.1 * 2, 6);
    const normal = computeVitusModel(10, 3, 0);
    expect(normal.mean).toBeGreaterThan(mirror.mean);
  });

  it("returns zero for an empty run", () => {
    const m = computeVitusModel(0, 3, 0);
    expect(m.mean).toBe(0);
    expect(m.std).toBe(0);
  });
});

describe("normCdf", () => {
  it("is 0.5 at the mean and monotonic", () => {
    expect(normCdf(50, 50, 10)).toBeCloseTo(0.5, 4);
    expect(normCdf(60, 50, 10)).toBeGreaterThan(normCdf(50, 50, 10));
    expect(normCdf(40, 50, 10)).toBeLessThan(normCdf(50, 50, 10));
  });

  it("approximates the standard normal tails", () => {
    expect(normCdf(50 + 2.326 * 10, 50, 10)).toBeCloseTo(0.99, 3);
    expect(normCdf(50 - 1.282 * 10, 50, 10)).toBeCloseTo(0.1, 3);
  });

  it("degenerates to a step function when std is 0", () => {
    expect(normCdf(49, 50, 0)).toBe(0);
    expect(normCdf(51, 50, 0)).toBe(1);
  });
});

describe("scenarioTable", () => {
  it("produces the 7 scenarios centered on the mean", () => {
    const rows = scenarioTable({ mean: 100, std: 10 });
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.prob === "50%")?.total).toBe(100);
    expect(rows[0].total).toBeLessThan(rows[6].total);
    expect(rows.find((r) => r.prob === "99%")?.total).toBe(Math.round(100 - 2.326 * 10));
  });

  it("never returns negative totals", () => {
    const rows = scenarioTable({ mean: 2, std: 10 });
    for (const r of rows) expect(r.total).toBeGreaterThanOrEqual(0);
  });
});
