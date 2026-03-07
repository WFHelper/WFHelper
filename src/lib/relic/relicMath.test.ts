import { describe, expect, it } from "vitest";

import { computeSquadEV, computeSquadDucatEV } from "./relicMath.js";

// ---------------------------------------------------------------------------
// computeSquadEV
// ---------------------------------------------------------------------------

describe("computeSquadEV", () => {
  it("computes solo EV as weighted average", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const prices = [10, 20];
    expect(computeSquadEV(rewards, prices, 1)).toBeCloseTo(15, 6);
  });

  it("computes squad of 2 EV (max-pick model)", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const prices = [10, 20];
    // With 2 picks, probability of picking the 20 item at least once increases
    expect(computeSquadEV(rewards, prices, 2)).toBeCloseTo(17.5, 6);
  });

  it("computes squad of 4 EV", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const prices = [10, 20];
    const ev4 = computeSquadEV(rewards, prices, 4);
    expect(ev4).toBeGreaterThan(17.5); // should be more biased to the 20
    expect(ev4).toBeCloseTo(19.375, 4);
  });

  it("handles all-zero prices", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    expect(computeSquadEV(rewards, [0, 0], 4)).toBeCloseTo(0, 6);
  });

  it("treats null prices as zero", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    expect(computeSquadEV(rewards, [null, 10], 1)).toBeCloseTo(5, 6);
  });

  it("groups same-price items correctly", () => {
    const rewards = [{ chance: 25 }, { chance: 25 }, { chance: 25 }, { chance: 25 }];
    const prices = [10, 10, 20, 20];
    // Solo: 0.25*10 + 0.25*10 + 0.25*20 + 0.25*20 = 15
    expect(computeSquadEV(rewards, prices, 1)).toBeCloseTo(15, 6);
  });

  it("handles single reward", () => {
    const rewards = [{ chance: 100 }];
    const prices = [42];
    expect(computeSquadEV(rewards, prices, 4)).toBeCloseTo(42, 6);
  });
});

// ---------------------------------------------------------------------------
// computeSquadDucatEV
// ---------------------------------------------------------------------------

describe("computeSquadDucatEV", () => {
  it("delegates to computeSquadEV with ducat values", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const ducats = [15, 100];
    const solo = computeSquadDucatEV(rewards, ducats, 1);
    expect(solo).toBeCloseTo(57.5, 6);
  });

  it("computes higher EV for larger squads", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const ducats = [15, 100];
    const solo = computeSquadDucatEV(rewards, ducats, 1);
    const squad4 = computeSquadDucatEV(rewards, ducats, 4);
    expect(squad4).toBeGreaterThan(solo);
  });
});
