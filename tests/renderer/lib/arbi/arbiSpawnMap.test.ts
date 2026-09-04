import { describe, expect, it } from "vitest";

import { computeSpawnMap } from "../../../../src/lib/arbi/arbiSpawnMap.js";
import type { ArbiSpawnPoint } from "../../../../config/shared/arbiTypes.js";

function point(id: string, x: number, z: number, count: number): ArbiSpawnPoint {
  return { id, x, y: 0, z, count };
}

describe("computeSpawnMap", () => {
  it("returns null without spawn data", () => {
    expect(computeSpawnMap(undefined)).toBeNull();
    expect(computeSpawnMap([])).toBeNull();
  });

  it("orders by count, labels by the path tail and shares out the total", () => {
    const map = computeSpawnMap([
      point("/Layer1/Layer1/NpcSpawnPoint7", 0, 0, 25),
      point("/Layer1/Layer1/NpcSpawnPoint129", 100, 100, 75),
    ]);
    if (!map) throw new Error("expected a map");

    expect(map.bubbles.map((b) => b.label)).toEqual(["129", "7"]);
    expect(map.totalSpawns).toBe(100);
    expect(map.maxCount).toBe(75);
    expect(map.bubbles[0].sharePct).toBeCloseTo(75, 6);
    expect(map.bubbles[1].sharePct).toBeCloseTo(25, 6);
    // busiest is green, quietest red
    expect(map.bubbles[0].hue).toBe(120);
    expect(map.bubbles[1].hue).toBe(0);
  });

  it("sizes bubbles by the square root of the count", () => {
    const map = computeSpawnMap([point("/a/P1", 0, 0, 100), point("/a/P2", 10, 10, 25)]);
    if (!map) throw new Error("expected a map");

    // sqrt(25/100) = 0.5 of the largest radius
    expect(map.bubbles[0].r).toBeCloseTo(map.bubbles[1].r * 2, 6);
  });

  it("scales x and z uniformly and centers a degenerate plan", () => {
    const square = computeSpawnMap([
      point("/a/P1", 0, 0, 1),
      point("/a/P2", 100, 100, 1),
      point("/a/P3", 0, 100, 1),
    ]);
    if (!square) throw new Error("expected a map");
    expect(square.bubbles.map((b) => [b.cx, b.cy])).toEqual([
      [8, 8],
      [92, 92],
      [8, 92],
    ]);
    // Every point tied: nothing is "the fewest", so none of them go red.
    expect(square.bubbles.every((b) => b.hue === 120)).toBe(true);

    const single = computeSpawnMap([point("/a/P1", 4200, -17, 3)]);
    if (!single) throw new Error("expected a map");
    expect(single.bubbles[0]).toMatchObject({ cx: 50, cy: 50 });
  });

  it("keeps the side list to the ten busiest points", () => {
    const points = Array.from({ length: 14 }, (_, i) => point(`/a/P${i}`, i, i, i + 1));
    const map = computeSpawnMap(points);
    if (!map) throw new Error("expected a map");

    expect(map.bubbles).toHaveLength(14);
    expect(map.top).toHaveLength(10);
    expect(map.top[0].count).toBe(14);
    expect(map.top[9].count).toBe(5);
  });
});
