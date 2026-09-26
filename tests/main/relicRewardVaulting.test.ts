import { describe, expect, it, vi } from "vitest";

import { getRelicRewardItems } from "../../services/relicService";

const relics = vi.hoisted(() => {
  const relic = (name: string, vaulted: boolean, rewards: string[], drops = 0) => ({
    uniqueName: `/Lotus/Types/Game/Projections/${name.replace(/ /g, "")}`,
    name,
    category: "Relics",
    vaulted,
    rewards: rewards.map((reward) => ({ chance: 25.33, rarity: "Common", item: { name: reward } })),
    drops: Array.from({ length: drops }, () => ({
      location: "Void/Mithra (Interception), Rotation C",
      chance: 0.29,
    })),
  });
  return [
    relic("Lith A1 Intact", true, ["Alpha Prime Blueprint", "Shared Prime Barrel"]),
    relic("Lith A1 Radiant", true, ["Alpha Prime Blueprint", "Shared Prime Barrel"]),
    relic("Meso B2 Intact", false, ["Shared Prime Barrel", "Bravo Prime Stock"]),
    relic("Axi D4 Intact", false, ["Forma Blueprint"]),
    relic("Neo C3 Intact", true, ["Forma Blueprint"]),
    relic("Axi C12 Intact", true, ["Charlie Prime Neuroptics Blueprint"], 2),
  ];
});

vi.mock("../../services/bundledGameData", () => ({ readWfcdItems: () => relics }));

vi.mock("../../services/itemDatabase", () => ({
  localizedNameFields: () => ({}),
  lookupItem: () => null,
  lookupItemByNameOrSlug: () => null,
  toIconMirrorUrl: (url: string) => url,
}));

describe("relic reward vaulting", () => {
  it("lists each reward once, vaulted only while every relic dropping it is vaulted", () => {
    expect(getRelicRewardItems().map(({ name, vaulted }) => ({ name, vaulted }))).toEqual([
      { name: "Alpha Prime Blueprint", vaulted: true },
      { name: "Bravo Prime Stock", vaulted: false },
      { name: "Charlie Prime Neuroptics Blueprint", vaulted: false },
      { name: "Forma Blueprint", vaulted: false },
      { name: "Shared Prime Barrel", vaulted: false },
    ]);
  });
});
