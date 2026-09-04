import { describe, expect, it } from "vitest";

import { SYNDICATE_RANKS } from "../../src/data/syndicateRanks.js";

describe("bundled syndicate rank table", () => {
  it("covers every rankable syndicate", () => {
    expect(SYNDICATE_RANKS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(SYNDICATE_RANKS.map((meta) => meta.tag)).size).toBe(SYNDICATE_RANKS.length);
  });

  it("carries no Nightwave season", () => {
    for (const meta of SYNDICATE_RANKS) {
      expect(meta.tag.startsWith("RadioLegion")).toBe(false);
      expect(meta.dailyBin).not.toBe("NONE");
    }
  });

  it("names a daily pool field and a wiki page for each entry", () => {
    for (const meta of SYNDICATE_RANKS) {
      expect(meta.dailyField).toMatch(/^DailyAffiliation/);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.wikiPage.length).toBeGreaterThan(0);
      expect(["normal", "openWorld", "other"]).toContain(meta.kind);
    }
  });

  it("keeps rank levels ascending and contiguous, apart from the missing rank 0", () => {
    for (const meta of SYNDICATE_RANKS) {
      expect(meta.titles.length).toBeGreaterThan(0);
      const levels = meta.titles.map((title) => title.level);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
      expect(levels).not.toContain(0);
      for (let i = 1; i < levels.length; i++) {
        const gap = levels[i] - levels[i - 1];
        // DE has no rank 0, so -1 jumps straight to 1 on the aligned six.
        expect(gap === 1 || (gap === 2 && levels[i - 1] === -1)).toBe(true);
      }
    }
  });

  it("keeps standing thresholds joined between neighbouring ranks", () => {
    for (const meta of SYNDICATE_RANKS) {
      for (const title of meta.titles) {
        expect(title.maxStanding).toBeGreaterThan(title.minStanding);
      }
      const positive = meta.titles.filter((title) => title.level > 0);
      for (let i = 1; i < positive.length; i++) {
        expect(positive[i].minStanding).toBe(positive[i - 1].maxStanding);
      }
    }
  });

  it("gives every sacrifice item a name and a real count", () => {
    const sacrifices = SYNDICATE_RANKS.flatMap((meta) => [
      ...(meta.initiation ? [meta.initiation] : []),
      ...meta.titles.flatMap((title) => (title.sacrifice ? [title.sacrifice] : [])),
    ]);
    expect(sacrifices.length).toBeGreaterThan(50);

    for (const sacrifice of sacrifices) {
      expect(sacrifice.credits).toBeGreaterThanOrEqual(0);
      for (const item of sacrifice.items) {
        expect(item.itemType.startsWith("/Lotus/")).toBe(true);
        expect(item.name.trim().length).toBeGreaterThan(0);
        // A name that is still a language path means the build fell back.
        expect(item.name.startsWith("/Lotus/")).toBe(false);
        expect(item.count).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("only lets the aligned six carry alignments, and always both ways", () => {
    const byTag = new Map(SYNDICATE_RANKS.map((meta) => [meta.tag, meta]));
    for (const meta of SYNDICATE_RANKS) {
      if (!meta.alignments) continue;
      expect(meta.kind).toBe("normal");
      for (const [other, factor] of Object.entries(meta.alignments)) {
        expect(byTag.get(other)?.alignments?.[meta.tag]).toBe(factor);
      }
    }
  });
});
