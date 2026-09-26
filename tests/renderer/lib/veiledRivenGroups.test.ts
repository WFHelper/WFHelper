import { describe, expect, it } from "vitest";

import { groupVeiledRivens } from "../../../src/lib/veiledRivenGroups.js";
import type { VeiledRivenEntry } from "../../../src/types/ipc.js";

const UNASSIGNED = "Challenge not yet assigned";

function entry(label: string, challengeGroup?: string): VeiledRivenEntry {
  return {
    itemType: `/Lotus/Upgrades/Mods/Randomized/Lotus${label}RandomModRare`,
    label,
    ...(challengeGroup ? { challengeGroup } : {}),
  };
}

function summary(groups: ReturnType<typeof groupVeiledRivens>) {
  return groups.map((group) => [group.label, group.entries.map((e) => e.label)]);
}

describe("groupVeiledRivens", () => {
  it("puts the largest group first and breaks ties by label", () => {
    const groups = groupVeiledRivens(
      [
        entry("Rifle", "Kill Enemies"),
        entry("Pistol", "Find Caches"),
        entry("Melee", "Synthesize a Simaris target"),
        entry("Shotgun", "Synthesize a Simaris target"),
        entry("Zaw", "Kill Enemies"),
        entry("Kitgun", "Synthesize a Simaris target"),
        entry("Archgun", "Catch fish"),
      ],
      UNASSIGNED,
    );

    expect(summary(groups)).toEqual([
      ["Synthesize a Simaris target", ["Melee", "Shotgun", "Kitgun"]],
      ["Kill Enemies", ["Rifle", "Zaw"]],
      ["Catch fish", ["Archgun"]],
      ["Find Caches", ["Pistol"]],
    ]);
  });

  it("collects rivens without a challenge in one final group", () => {
    const groups = groupVeiledRivens(
      [entry("Rifle"), entry("Pistol", "Find Caches"), entry("Melee")],
      UNASSIGNED,
    );

    expect(summary(groups)).toEqual([
      ["Find Caches", ["Pistol"]],
      [UNASSIGNED, ["Rifle", "Melee"]],
    ]);
  });

  it("returns no groups for no rivens", () => {
    expect(groupVeiledRivens([], UNASSIGNED)).toEqual([]);
  });
});
