import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("canonicalSyndicateKey", () => {
  it("folds every display name onto its syndicate tag", async () => {
    const { canonicalSyndicateKey } = await import("../../../src/lib/bountyRewards.js");
    expect(canonicalSyndicateKey("Ostrons")).toBe("CetusSyndicate");
    expect(canonicalSyndicateKey("Solaris United")).toBe("SolarisSyndicate");
    expect(canonicalSyndicateKey("Entrati")).toBe("EntratiSyndicate");
    expect(canonicalSyndicateKey("The Holdfasts")).toBe("ZarimanSyndicate");
    expect(canonicalSyndicateKey("Cavia")).toBe("EntratiLabSyndicate");
    expect(canonicalSyndicateKey("The Hex")).toBe("HexSyndicate");
  });

  it("passes a tag and an unknown name through unchanged", async () => {
    const { canonicalSyndicateKey } = await import("../../../src/lib/bountyRewards.js");
    expect(canonicalSyndicateKey("CetusSyndicate")).toBe("CetusSyndicate");
    expect(canonicalSyndicateKey("Steel Meridian")).toBe("Steel Meridian");
  });
});

describe("getBountyRewards", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects seed-bounty pools by tier index, falling back to level match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => hexDrops })),
    );
    const { getBountyRewards } = await import("../../../src/lib/bountyRewards.js");

    // In-game tier 1 shows 65-70, but its pool is labeled 55-60 - index must win.
    const byIndex = await getBountyRewards("HexSyndicate", [65, 70], 1, undefined, 0);
    expect(byIndex[0]?.items.map((i) => i.itemName)).toEqual(["Tier1 Mod"]);

    const byLevel = await getBountyRewards("HexSyndicate", [65, 70], 1);
    expect(byLevel[0]?.items.map((i) => i.itemName)).toEqual(["Tier2 Mod"]);
  });

  it.each([429, 503])("retries after a transient HTTP %s response", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          cetusBountyRewards: [
            {
              bountyLevel: "Level 1 - 5",
              rewards: {
                A: [
                  {
                    itemName: "Recovered Reward",
                    chance: 10,
                    rarity: "Rare",
                    stage: "Final Stage",
                  },
                ],
              },
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { getBountyRewards } = await import("../../../src/lib/bountyRewards.js");

    await expect(getBountyRewards("CetusSyndicate", [1, 5], 1)).rejects.toThrow(`HTTP ${status}`);
    await expect(getBountyRewards("CetusSyndicate", [1, 5], 1)).resolves.toMatchObject([
      { items: [{ itemName: "Recovered Reward" }] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a rejected request", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => hexDrops });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { getBountyRewards } = await import("../../../src/lib/bountyRewards.js");

    await expect(getBountyRewards("HexSyndicate", [65, 70], 1)).rejects.toThrow("offline");
    await expect(getBountyRewards("HexSyndicate", [65, 70], 1)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps successful requests cached", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => hexDrops }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { getBountyRewards } = await import("../../../src/lib/bountyRewards.js");

    await getBountyRewards("HexSyndicate", [65, 70], 1);
    await getBountyRewards("HexSyndicate", [65, 70], 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
