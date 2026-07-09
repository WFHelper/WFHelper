import { afterEach, describe, expect, it, vi } from "vitest";

import { getBountyRewards } from "../../../src/lib/bountyRewards.js";

// Hex drops file: pool labels sit 10 below the in-game levels, ordered tier 1..N.
const hexDrops = {
  hexRewards: [
    {
      bountyLevel: "Level  55 - 60 WF1999 Bounty",
      rewards: { A: [{ itemName: "Tier1 Mod", chance: 10, rarity: "Rare", stage: "Final stage" }] },
    },
    {
      bountyLevel: "Level  65 - 70 WF1999 Bounty",
      rewards: { A: [{ itemName: "Tier2 Mod", chance: 10, rarity: "Rare", stage: "Final stage" }] },
    },
  ],
};

describe("getBountyRewards", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects seed-bounty pools by tier index, falling back to level match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => hexDrops })));

    // In-game tier 1 shows 65-70, but its pool is labeled 55-60 - index must win.
    const byIndex = await getBountyRewards("HexSyndicate", [65, 70], 1, undefined, 0);
    expect(byIndex[0]?.items.map((i) => i.itemName)).toEqual(["Tier1 Mod"]);

    const byLevel = await getBountyRewards("HexSyndicate", [65, 70], 1);
    expect(byLevel[0]?.items.map((i) => i.itemName)).toEqual(["Tier2 Mod"]);
  });
});
