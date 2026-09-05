import { beforeEach, describe, expect, it } from "vitest";

import type { ArbiSpawnPoint } from "../../../../config/shared/arbiTypes.js";
import minimapData from "../../../../src/data/arbiMinimaps.json";
import { __test__, resolveMinimap } from "../../../../src/lib/arbi/arbiMinimap.js";

// Real catalog, not the synthetic one the sibling suite mocks: gaia carries 550
// reference positions, which is where the alignment cost actually shows up.
const GAIA = (minimapData.catalog as Record<string, { spawnPoints?: Record<string, number[][]> }>)
  .gaia;
const GAIA_RUN = { id: "run-1", node: "Gaia", solNode: "SolNode85" };

function gaiaPoints(count: number): ArbiSpawnPoint[] {
  return Object.values(GAIA.spawnPoints ?? {})
    .flat()
    .slice(0, count)
    .map((position, index) => ({
      id: `/Layer1/Layer1/NpcSpawnPoint${index + 1}`,
      x: position[0],
      y: position[1],
      z: position[2],
      count: 1 + (index % 7),
    }));
}

describe("resolveMinimap memo", () => {
  beforeEach(() => {
    __test__.resetMinimapMemoForTest();
  });

  it("aligns the gaia run once and reuses the result", () => {
    const first = resolveMinimap(GAIA_RUN, gaiaPoints(60));
    expect(first?.key).toBe("gaia");
    expect(first?.matchedPoints.size).toBe(60);
    expect(__test__.alignmentRunsForTest()).toBe(1);

    // A patched record is a fresh object holding equal spawn data.
    const again = resolveMinimap({ ...GAIA_RUN }, gaiaPoints(60));
    expect(again).toBe(first);
    expect(__test__.alignmentRunsForTest()).toBe(1);
  });

  it("re-aligns when the run, the node or the spawn data changes", () => {
    const points = gaiaPoints(60);
    const base = resolveMinimap(GAIA_RUN, points);
    expect(__test__.alignmentRunsForTest()).toBe(1);

    expect(resolveMinimap({ ...GAIA_RUN, id: "run-2" }, points)).not.toBe(base);
    expect(__test__.alignmentRunsForTest()).toBe(2);

    // Another node, so another layout: gaia's cloud cannot land on it.
    expect(resolveMinimap({ id: "run-3", node: "Callisto", solNode: "SolNode25" }, points)).toBe(
      null,
    );
    expect(__test__.alignmentRunsForTest()).toBe(3);

    resolveMinimap(GAIA_RUN, gaiaPoints(80));
    expect(__test__.alignmentRunsForTest()).toBe(4);
  });

  it("keeps a repeat resolution far cheaper than the first", () => {
    const points = gaiaPoints(300);
    const coldStart = performance.now();
    resolveMinimap(GAIA_RUN, points);
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    resolveMinimap({ ...GAIA_RUN }, points);
    const warmMs = performance.now() - warmStart;

    // Cold is ~300ms here; a generous factor keeps this off a slow CI box's back.
    expect(coldMs).toBeGreaterThan(20);
    expect(warmMs).toBeLessThan(coldMs / 10);
  });
});
