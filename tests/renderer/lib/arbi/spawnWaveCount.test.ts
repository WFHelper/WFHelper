import { describe, expect, it } from "vitest";

import type { ArbiSpawnPoint } from "../../../../config/shared/arbiTypes.js";
import { ARBI_EARLY_WAVE_CAP, countFromWave } from "../../../../config/shared/arbiTypes.js";

/** Per-wave counts, index 0 = wave 1, padded to the parser's cap. */
function early(counts: Record<number, number>): number[] {
  return Array.from({ length: ARBI_EARLY_WAVE_CAP }, (_, index) => counts[index + 1] ?? 0);
}

function point(waves?: number[]): ArbiSpawnPoint {
  return {
    id: "/Layer1/NpcSpawnPoint1",
    x: 0,
    y: 0,
    z: 0,
    count: 10,
    ...(waves ? { early: waves } : {}),
  };
}

describe("countFromWave", () => {
  it("cuts every wave below the floor's first one", () => {
    expect(countFromWave(point(early({ 1: 4, 7: 6 })), 7)).toBe(6);
    expect(countFromWave(point(early({ 1: 4, 7: 6 })), 8)).toBe(0);
  });

  it("keeps the full count without per-wave data and without a cut", () => {
    expect(countFromWave(point(), 7)).toBe(10);
    expect(countFromWave(point(early({ 1: 4, 7: 6 })), 1)).toBe(10);
  });

  it("keeps cutting every tracked wave past the window", () => {
    expect(countFromWave(point(early({ 1: 4, 7: 6 })), ARBI_EARLY_WAVE_CAP + 1)).toBe(0);
    expect(countFromWave(point(early({ 1: 4, 7: 6 })), ARBI_EARLY_WAVE_CAP + 2)).toBe(0);
    // Untracked spawns survive the cut: the tracked waves hold 6 of the 10.
    expect(countFromWave(point(early({ 1: 4, 7: 2 })), ARBI_EARLY_WAVE_CAP + 5)).toBe(4);
  });

  it("never rises as the floor moves up", () => {
    const spawn = point(early({ 1: 4, 7: 2, 15: 1 }));
    let previous = countFromWave(spawn, 1);
    for (let minWave = 2; minWave <= ARBI_EARLY_WAVE_CAP + 5; minWave++) {
      const current = countFromWave(spawn, minWave);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
    // Without per-wave data every floor answers the same full count.
    expect(countFromWave(point(), ARBI_EARLY_WAVE_CAP + 5)).toBe(10);
  });
});
