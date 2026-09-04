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

function cloudToReference(cloud: [number, number][], y: number): Record<string, number[][]> {
  return Object.fromEntries(cloud.map(([x, z], index) => [String(index + 1), [[x, y, z]]]));
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
    },
    nodes: { SolNode1: ["alpha", "beta"], SolNode2: ["beta"] },
  },
}));

const { placeSpawnPoints, resolveMinimap } =
  await import("../../../../src/lib/arbi/arbiMinimap.js");

function points(
  cloud: [number, number][],
  y: number,
  map: (x: number, z: number) => [number, number] = (x, z) => [x, z],
): ArbiSpawnPoint[] {
  return cloud.map(([rawX, rawZ], index) => {
    const [x, z] = map(rawX, rawZ);
    return { id: `/Layer1/Layer1/NpcSpawnPoint${index + 1}`, x, y, z, count: index + 1 };
  });
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
    const placement = placeSpawnPoints(map, upstairs, 100);
    expect(placement.positions.size).toBe(upstairs.length);
    expect(placement.radiusScale).toBe(10);
    expect(placement.positions.get("/Layer1/Layer1/NpcSpawnPoint5")).toEqual({
      cx: 660,
      cy: 550,
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
