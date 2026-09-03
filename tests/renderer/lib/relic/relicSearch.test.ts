import { describe, expect, it } from "vitest";

import {
  buildRelicSearchKeywordIndex,
  relicGroupHasMatchingReward,
  relicGroupMatchesSearch,
} from "../../../../src/lib/relic/relicSearch.js";
import type { RelicDatabase, RelicGroup } from "../../../../src/types/relics.js";

function makeGroup(overrides: Partial<RelicGroup> = {}): RelicGroup {
  return {
    key: "Neo Z9",
    name: "Neo Z9",
    tier: "Neo",
    code: "Z9",
    imageUrl: null,
    qualities: {
      intact: {
        uniqueName: "/Lotus/Relics/NeoZ9Intact",
        rewards: [
          {
            name: "Braton Prime Barrel",
            rarity: "Common",
            chance: 25,
            urlName: "braton_prime_barrel",
            ducats: 15,
          },
          {
            name: "Saryn Prime Neuroptics",
            rarity: "Rare",
            chance: 2,
            urlName: "saryn_prime_neuroptics",
            ducats: 100,
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("relicGroupMatchesSearch", () => {
  it("returns true for empty query (matches everything)", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "")).toBe(true);
  });

  it("matches by relic name", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "Neo Z9")).toBe(true);
  });

  it("matches by partial relic name (tier)", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "Neo")).toBe(true);
  });

  it("matches by reward name", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "Braton Prime")).toBe(true);
  });

  it("matches by reward urlName", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "saryn prime neuroptics")).toBe(true);
  });

  it("matches compact query (no spaces)", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "neoz9")).toBe(true);
  });

  it("matches multi-token query", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "neo z9")).toBe(true);
  });

  it("returns false for non-matching query", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "Axi A1")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "BRATON PRIME")).toBe(true);
  });

  it("strips stripped words like 'prime' and 'blueprint' for broader match", () => {
    // "Braton Barrel" should match because "prime" and "blueprint" are stripped from terms
    expect(relicGroupMatchesSearch(makeGroup(), "braton barrel")).toBe(true);
  });
});

describe("buildRelicSearchKeywordIndex", () => {
  it("returns empty for null/undefined db", () => {
    expect(buildRelicSearchKeywordIndex(null)).toEqual({});
    expect(buildRelicSearchKeywordIndex(undefined)).toEqual({});
  });

  it("returns empty for db with no groups", () => {
    const db: RelicDatabase = { groups: {}, byUniqueName: {} };
    expect(buildRelicSearchKeywordIndex(db)).toEqual({});
  });

  it("indexes quality uniqueNames with search terms", () => {
    const group = makeGroup();
    const db: RelicDatabase = {
      groups: { "Neo Z9": group },
      byUniqueName: {},
    };
    const index = buildRelicSearchKeywordIndex(db);
    expect(index["/Lotus/Relics/NeoZ9Intact"]).toBeDefined();
    expect(index["/Lotus/Relics/NeoZ9Intact"].length).toBeGreaterThan(0);
  });

  it("includes relic name and reward names in terms", () => {
    const group = makeGroup();
    const db: RelicDatabase = {
      groups: { "Neo Z9": group },
      byUniqueName: {},
    };
    const index = buildRelicSearchKeywordIndex(db);
    const terms = index["/Lotus/Relics/NeoZ9Intact"];
    expect(terms.some((t) => t.includes("neo z9"))).toBe(true);
    expect(terms.some((t) => t.includes("braton"))).toBe(true);
    expect(terms.some((t) => t.includes("saryn"))).toBe(true);
  });
});

describe("relicGroupHasMatchingReward", () => {
  it("matches rewards across a relic's qualities", () => {
    expect(
      relicGroupHasMatchingReward(makeGroup(), (reward) => reward.name.includes("Saryn")),
    ).toBe(true);
    expect(
      relicGroupHasMatchingReward(makeGroup(), (reward) => reward.name.includes("Forma")),
    ).toBe(false);
  });
});

describe("relicGroupMatchesSearch quality words", () => {
  const labels = {
    intact: "Intakt",
    exceptional: "Aussergewoehnlich",
    flawless: "Makellos",
    radiant: "Strahlend",
  };

  it("keeps groups owned at the typed refinement", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "radiant", { ownedCounts: { radiant: 2 } })).toBe(
      true,
    );
    expect(relicGroupMatchesSearch(makeGroup(), "Radiant", { ownedCounts: { intact: 3 } })).toBe(
      false,
    );
    expect(relicGroupMatchesSearch(makeGroup(), "radiant", { ownedCounts: null })).toBe(false);
  });

  it("combines a refinement word with a text term", () => {
    expect(
      relicGroupMatchesSearch(makeGroup(), "radiant braton", { ownedCounts: { radiant: 1 } }),
    ).toBe(true);
    expect(
      relicGroupMatchesSearch(makeGroup(), "radiant saryn", { ownedCounts: { radiant: 1 } }),
    ).toBe(true);
    expect(
      relicGroupMatchesSearch(makeGroup(), "radiant nikana", { ownedCounts: { radiant: 1 } }),
    ).toBe(false);
  });

  it("understands the localised refinement label", () => {
    const options = { qualityLabels: labels, ownedCounts: { flawless: 1 } };
    expect(relicGroupMatchesSearch(makeGroup(), "Makellos", options)).toBe(true);
    expect(relicGroupMatchesSearch(makeGroup(), "Strahlend", options)).toBe(false);
  });

  it("understands a Chinese refinement label", () => {
    const zhLabels = {
      intact: "完整",
      exceptional: "优良",
      flawless: "完美无瑕",
      radiant: "光辉",
    };
    const options = { qualityLabels: zhLabels, ownedCounts: { radiant: 1 } };
    expect(relicGroupMatchesSearch(makeGroup(), "光辉", options)).toBe(true);
    expect(relicGroupMatchesSearch(makeGroup(), "完整", options)).toBe(false);
    expect(relicGroupMatchesSearch(makeGroup(), "完美无瑕", options)).toBe(false);
  });

  it("ignores refinement words without inventory data", () => {
    expect(relicGroupMatchesSearch(makeGroup(), "radiant")).toBe(true);
    expect(relicGroupMatchesSearch(makeGroup(), "radiant nikana")).toBe(false);
  });
});
