import { describe, expect, it, vi } from "vitest";

import type { ArbiSpawnPoint } from "../../../../config/shared/arbiTypes.js";

// Two synthetic layouts stand in for the mirrored catalog: alpha is calibrated
// at 10 px per world unit, beta at 5, and both clouds are asymmetric so only one
// planar transform can ever fit.
const ALPHA_CLOUD: [number, number][] = [
  [0, 0],
  [3, 1],
  [7, 2],
  [12, 1.5],
  [16, 5],
  [2, 9],
  [6, 13],
  [11, 17],
  [17, 21],
  [23, 4],
  [27, 12],
  [31, 25],
  [35, 8],
  [39, 19],
  [43, 30],
  [47, 11],
];
const BETA_CLOUD: [number, number][] = ALPHA_CLOUD.map(([x, z]) => [z * 1.7 + 1, x * 0.6 - 3]);
// Nothing in this cloud can land on a reference position, so it stands in for
// the arena a floor-specific layout is not drawing.
const UPPER_CLOUD: [number, number][] = ALPHA_CLOUD.map(([x, z], index) => [
  x * 1.31 + index * 0.7,
  z * 0.83 - index * 1.1,
]);
/** Bottom floor of the gamma tile: every reference sits at its own height. */
const gammaHeight = (index: number): number => -20 + index;

function cloudToReference(
  cloud: [number, number][],
  y: number | ((index: number) => number),
): Record<string, number[][]> {
  return Object.fromEntries(
    cloud.map(([x, z], index) => [
      String(index + 1),
      [[x, typeof y === "function" ? y(index) : y, z]],
    ]),
  );
}

vi.mock("../../../../src/data/arbiMinimaps.json", () => ({
  default: {
    source: "test",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    version: 2,
    catalog: {
      alpha: {
        src: "alpha.webp",
        width: 1000,
        height: 1000,
        matrix: [10, 0, 500, 0, 10, 500],
        label: "Alpha / Bravo",
        spawnPoints: cloudToReference(ALPHA_CLOUD, 0),
      },
      beta: {
        src: "beta.webp",
        width: 800,
        height: 600,
        matrix: [5, 0, 400, 0, 5, 300],
        label: "Beta",
        spawnPoints: cloudToReference(BETA_CLOUD, -20),
      },
      gamma: {
        src: "gamma.webp",
        width: 1000,
        height: 1000,
        matrix: [10, 0, 500, 0, 10, 500],
        label: "Gamma",
        spawnPoints: cloudToReference(ALPHA_CLOUD, gammaHeight),
        floorFilter: { label: "bottom", maxY: -4, minWave: 7 },
      },
      delta: {
        src: "delta.webp",
        width: 1000,
        height: 1000,
        matrix: [10, 0, 500, 0, 10, 500],
        label: "Delta",
        spawnPoints: cloudToReference(ALPHA_CLOUD, gammaHeight),
        floorFilter: { label: "bottom", maxY: -4 },
      },
      epsilon: {
        src: "epsilon.webp",
        width: 1000,
        height: 1000,
        matrix: [10, 0, 500, 0, 10, 500],
        label: "Epsilon",
        spawnPoints: cloudToReference(ALPHA_CLOUD, gammaHeight),
        floorFilter: { label: "attic", maxY: -4 },
      },
    },
    nodes: {
      SolNode1: ["alpha", "beta"],
      SolNode2: ["beta"],
      SolNode3: ["gamma"],
      SolNode4: ["delta"],
      SolNode5: ["epsilon"],
    },
  },
}));

const { applyFloorFilter, drawnSpawnPoints, placeSpawnPoints, resolveMinimap } =
  await import("../../../../src/lib/arbi/arbiMinimap.js");

function points(
  cloud: [number, number][],
  y: number | ((index: number) => number),
  map: (x: number, z: number) => [number, number] = (x, z) => [x, z],
): ArbiSpawnPoint[] {
  return cloud.map(([rawX, rawZ], index) => {
    const [x, z] = map(rawX, rawZ);
    return {
      id: `/Layer1/Layer1/NpcSpawnPoint${index + 1}`,
      x,
      y: typeof y === "function" ? y(index) : y,
      z,
      count: index + 1,
    };
  });
}

/** Per-wave counts, index 0 = wave 1, padded to the parser's cap. */
function early(counts: Record<number, number>): number[] {
  return Array.from({ length: 15 }, (_, index) => counts[index + 1] ?? 0);
}

/** A run split over two arenas: the bottom floor only opens on wave 7. */
function twoFloorRun(withWaves = true): ArbiSpawnPoint[] {
  const bottom = points(ALPHA_CLOUD, gammaHeight).map((point) => ({
    ...point,
    count: 10,
    ...(withWaves ? { early: early({ 1: 2, 2: 4, 7: 4 }) } : {}),
  }));
  const upper = points(UPPER_CLOUD, 40).map((point) => ({
    ...point,
    id: `${point.id}u`,
    count: 6,
    ...(withWaves ? { early: early({ 1: 3, 5: 3 }) } : {}),
  }));
  return [...bottom, ...upper];
}

describe("resolveMinimap", () => {
  it("aligns an untransformed run and places it through the matrix", () => {
    const map = resolveMinimap({ node: "", solNode: "SolNode1" }, points(ALPHA_CLOUD, 0));
    expect(map?.key).toBe("alpha");
    expect(map?.transform).toBe("x,z");
    expect(map?.matchedPoints.size).toBe(ALPHA_CLOUD.length);
    expect(map?.score).toBe(1);
    expect(map?.imageUrl).toBe("https://assets.wfhelper.com/arbi-minimaps/alpha.webp");
    const placed = map?.place({ x: 16, y: 0, z: 5 });
    expect(placed?.px).toBeCloseTo(660, 6);
    expect(placed?.py).toBeCloseTo(550, 6);
  });

  it("recovers a mirrored and translated run", () => {
    const run = points(ALPHA_CLOUD, 12, (x, z) => [-x + 300, z - 45]);
    const map = resolveMinimap({ node: "", solNode: "SolNode1" }, run);
    expect(map?.key).toBe("alpha");
    expect(map?.transform).toBe("-x,z");
    expect(map?.matchedPoints.size).toBe(ALPHA_CLOUD.length);
    // The mirrored run still lands where the untransformed one did.
    expect(map?.place(run[4]).px).toBeCloseTo(660, 3);
    expect(map?.place(run[4]).py).toBeCloseTo(550, 3);
  });

  it("prefers the layout the run actually matches", () => {
    const map = resolveMinimap({ node: "", solNode: "SolNode1" }, points(BETA_CLOUD, -20));
    expect(map?.key).toBe("beta");
    expect(map?.width).toBe(800);
    expect(map?.height).toBe(600);
  });

  it("falls back to the node name when the run has no solNode", () => {
    expect(resolveMinimap({ node: "Bravo (Mars)" }, points(ALPHA_CLOUD, 0))?.key).toBe("alpha");
    expect(resolveMinimap({ node: "Beta (Venus)" }, points(BETA_CLOUD, -20))?.key).toBe("beta");
    expect(resolveMinimap({ node: "Gamma (Ceres)" }, points(ALPHA_CLOUD, 0))).toBe(null);
  });

  it("keeps points from other floors unmatched but still placeable", () => {
    const upstairs = points(ALPHA_CLOUD, 0).concat(
      points(ALPHA_CLOUD.slice(0, 6), 40).map((point) => ({
        ...point,
        id: `${point.id}b`,
      })),
    );
    const map = resolveMinimap({ node: "", solNode: "SolNode1" }, upstairs);
    expect(map?.matchedPoints.size).toBe(ALPHA_CLOUD.length);
    if (!map) throw new Error("expected a map");
    const placement = placeSpawnPoints(map, upstairs);
    expect(placement.size).toBe(upstairs.length);
    // Every alpha reference sits at the same height, so there is one band.
    expect(placement.get("/Layer1/Layer1/NpcSpawnPoint5")).toEqual({
      cx: 660,
      cy: 550,
      level: 0,
    });
  });

  it("returns null for too few points, no candidate and a foreign cloud", () => {
    expect(resolveMinimap({ solNode: "SolNode1" }, points(ALPHA_CLOUD.slice(0, 8), 0))).toBe(null);
    expect(resolveMinimap({ solNode: "SolNode9" }, points(ALPHA_CLOUD, 0))).toBe(null);
    expect(resolveMinimap({ solNode: "SolNode1" }, undefined)).toBe(null);
    const foreign = points(
      ALPHA_CLOUD.map(([x, z], index) => [x * 1.31 + index * 0.7, z * 0.83 - index * 1.1]),
      0,
    );
    expect(resolveMinimap({ solNode: "SolNode1" }, foreign)).toBe(null);
  });

  it("rejects a run where only a handful of points land on the layout", () => {
    const partial = points(ALPHA_CLOUD.slice(0, 11), 0).concat(
      points(ALPHA_CLOUD.slice(11), 0).map((point) => ({ ...point, x: point.x + 137.5 })),
    );
    expect(resolveMinimap({ solNode: "SolNode1" }, partial)).toBe(null);
  });
});

describe("applyFloorFilter", () => {
  function resolve(solNode: string, run: ArbiSpawnPoint[]) {
    const map = resolveMinimap({ solNode }, run);
    if (!map) throw new Error(`expected a map for ${solNode}`);
    return map;
  }

  it("recounts from the floor's first wave and keeps only what it claims", () => {
    const run = twoFloorRun();
    const map = resolve("SolNode3", run);
    expect(map.key).toBe("gamma");

    const floor = applyFloorFilter(map, run);
    expect(floor.floorLabel).toBe("bottom");
    expect(floor.points).toHaveLength(ALPHA_CLOUD.length);
    // 10 spawns each, 6 of them before wave 7.
    expect(floor.points.every((point) => point.count === 4)).toBe(true);
    expect(floor.points.some((point) => point.id.endsWith("u"))).toBe(false);
    expect(floor.matched.size).toBe(ALPHA_CLOUD.length);
  });

  it("keeps the full count on records saved without per-wave data", () => {
    const run = twoFloorRun(false);
    const floor = applyFloorFilter(resolve("SolNode3", run), run);

    expect(floor.points).toHaveLength(ALPHA_CLOUD.length);
    expect(floor.points.every((point) => point.count === 10)).toBe(true);
  });

  it("drops the other floor by height when there is no wave cut", () => {
    const run = twoFloorRun();
    const map = resolve("SolNode4", run);
    expect(map.key).toBe("delta");

    const floor = applyFloorFilter(map, run);
    expect(floor.floorLabel).toBe("bottom");
    expect(floor.points).toHaveLength(ALPHA_CLOUD.length);
    // Only a wave cut recounts; a height range leaves the totals alone.
    expect(floor.points.every((point) => point.count === 10)).toBe(true);
  });

  it("drops a floor name outside the vocabulary but still cuts the floor", () => {
    const run = twoFloorRun();
    const map = resolve("SolNode5", run);
    expect(map.key).toBe("epsilon");

    const floor = applyFloorFilter(map, run);
    expect(floor.floorLabel).toBe(null);
    expect(floor.points).toHaveLength(ALPHA_CLOUD.length);
  });

  it("keeps every point when the layout covers the whole tile", () => {
    const run = points(ALPHA_CLOUD, 0).concat(
      points(ALPHA_CLOUD.slice(0, 6), 40).map((point) => ({ ...point, id: `${point.id}b` })),
    );
    const floor = applyFloorFilter(resolve("SolNode1", run), run);

    expect(floor.floorLabel).toBe(null);
    expect(floor.points).toHaveLength(run.length);
    // The six upstairs points stay in the totals but have nowhere to be drawn.
    expect(floor.matched.size).toBe(ALPHA_CLOUD.length);
  });

  it("counts only the points the tile can draw", () => {
    const run = points(ALPHA_CLOUD, 0).concat(
      points(ALPHA_CLOUD.slice(0, 6), 40).map((point) => ({ ...point, id: `${point.id}b` })),
    );
    const floor = applyFloorFilter(resolve("SolNode1", run), run);

    expect(floor.points).toHaveLength(run.length);
    expect(drawnSpawnPoints(floor).map((point) => point.id)).toEqual(
      points(ALPHA_CLOUD, 0).map((point) => point.id),
    );
  });

  it("re-claims the floor in the alignment's own point order", () => {
    const bottom = points(ALPHA_CLOUD, gammaHeight).map((point) => ({
      ...point,
      count: 10,
      early: early({ 1: 2, 2: 4, 7: 4 }),
    }));
    // Two ids compete for one reference position, and the stored order puts the
    // twin first; the greedy claim must still follow the alignment's id order.
    const twin = { ...bottom[4], id: `${bottom[4].id}-twin`, x: bottom[4].x + 0.05 };
    const run = [twin, ...bottom];
    const map = resolve("SolNode3", run);
    const floor = applyFloorFilter(map, run);

    expect(floor.matched.has(bottom[4].id)).toBe(true);
    expect(floor.matched.has(twin.id)).toBe(false);
    expect([...floor.matched].sort()).toEqual([...map.matchedPoints].sort());
  });

  it("bands the placed points by the layout's own heights", () => {
    const run = twoFloorRun();
    const map = resolve("SolNode3", run);
    const placement = placeSpawnPoints(map, applyFloorFilter(map, run).points);

    expect(placement.get("/Layer1/Layer1/NpcSpawnPoint1")?.level).toBe(0);
    expect(placement.get("/Layer1/Layer1/NpcSpawnPoint16")?.level).toBe(4);
  });
});
