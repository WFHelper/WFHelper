import { describe, expect, it } from "vitest";

import { getRelicDatabase, getRelicRewardItems } from "../../services/relicService";

// A reward is vaulted only while every relic that can drop it is vaulted, so
// the expectation is rebuilt from the relic groups instead of naming items that
// leave the vault with the next unvaulting.
function vaultingByRewardName(): Map<string, boolean> {
  const expected = new Map<string, boolean>();
  for (const group of Object.values(getRelicDatabase().groups)) {
    for (const quality of Object.values(group.qualities)) {
      for (const reward of quality.rewards) {
        if (!reward.name) continue;
        const seen = expected.get(reward.name);
        expected.set(reward.name, seen === undefined ? group.vaulted : seen && group.vaulted);
      }
    }
  }
  return expected;
}

describe("relic reward vaulting", () => {
  const rows = getRelicRewardItems();
  const expected = vaultingByRewardName();

  it("tags every reward and keeps one row per name", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    for (const row of rows) expect(typeof row.vaulted, row.name).toBe("boolean");
  });

  it("marks a reward vaulted only when no live relic drops it", () => {
    for (const row of rows) expect(row.vaulted, row.name).toBe(expected.get(row.name));
    const values = new Set(rows.map((row) => row.vaulted));
    expect(values).toEqual(new Set([true, false]));
  });
});
