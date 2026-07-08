import { describe, expect, it } from "vitest";

import {
  buildNodeCatalog,
  buildSearchState,
  factionBadgeKey,
  filterScheduleEntries,
  formatScheduleCountdown,
  formatUpdatedAgo,
  groupEntriesByDay,
  matchesSearch,
  searchUnmatchedFeedback,
} from "../../../src/lib/world/arbiScheduleData.js";
import type { ArbiScheduleEntry } from "../../../src/types/ipc.js";

function entry(
  epochMs: number,
  nodeId: string,
  node = "Casta (Ceres)",
  mission = "Defense",
  faction = "Grineer",
): ArbiScheduleEntry {
  return { epochMs, nodeId, node, mission, faction };
}

const CASTA = entry(0, "SolNode149");
const ALATOR = entry(0, "SolNode109", "Alator (Mars)", "Interception", "Grineer");
const OESTRUS = entry(0, "SolNode167", "Oestrus (Eris)", "Infested Salvage", "Infested");

describe("buildNodeCatalog", () => {
  it("dedups by nodeId and sorts by name", () => {
    const catalog = buildNodeCatalog([CASTA, OESTRUS, entry(99, "SolNode149"), ALATOR]);
    expect(catalog.map((n) => n.node)).toEqual([
      "Alator (Mars)",
      "Casta (Ceres)",
      "Oestrus (Eris)",
    ]);
  });
});

describe("search", () => {
  const nodes = buildNodeCatalog([CASTA, ALATOR, OESTRUS]);

  it("matches multi-token node searches (site semantics)", () => {
    const state = buildSearchState("alator casta", nodes);
    expect(state.matchedTokens).toEqual(["alator", "casta"]);
    expect(matchesSearch(state, "Casta (Ceres)", "Defense", "Grineer")).toBe(true);
    expect(matchesSearch(state, "Alator (Mars)", "Interception", "Grineer")).toBe(true);
    expect(matchesSearch(state, "Oestrus (Eris)", "Infested Salvage", "Infested")).toBe(false);
  });

  it("falls back to full-query match on mission/faction when no node token matches", () => {
    const state = buildSearchState("infested", nodes);
    expect(matchesSearch(state, "Oestrus (Eris)", "Infested Salvage", "Infested")).toBe(true);
    expect(matchesSearch(state, "Casta (Ceres)", "Defense", "Grineer")).toBe(false);
  });

  it("reports tokens that match no node", () => {
    expect(searchUnmatchedFeedback(buildSearchState("casta zzz", nodes))).toBe("zzz");
    expect(searchUnmatchedFeedback(buildSearchState("casta", nodes))).toBeNull();
  });
});

describe("filterScheduleEntries", () => {
  const now = 50_000_000_000;
  const hour = 3_600_000;
  const list = [
    entry(now + hour, "SolNode149"),
    entry(now + 40 * 24 * hour, "SolNode149"),
    entry(now + 2 * hour, "SolNode167", "Oestrus (Eris)", "Infested Salvage", "Infested"),
  ];

  it("applies days cutoff, node selection and search", () => {
    const all = filterScheduleEntries(list, new Set(), buildSearchState("", []), 30, now);
    expect(all).toHaveLength(2);

    const onlyCasta = filterScheduleEntries(
      list,
      new Set(["SolNode149"]),
      buildSearchState("", []),
      60,
      now,
    );
    expect(onlyCasta).toHaveLength(2);
    expect(onlyCasta.every((e) => e.nodeId === "SolNode149")).toBe(true);
  });
});

describe("groupEntriesByDay", () => {
  it("splits on local calendar days preserving order", () => {
    const day1 = new Date(2026, 6, 8, 22, 0).getTime();
    const day1b = new Date(2026, 6, 8, 23, 0).getTime();
    const day2 = new Date(2026, 6, 9, 1, 0).getTime();
    const groups = groupEntriesByDay([
      entry(day1, "a"),
      entry(day1b, "b"),
      entry(day2, "c"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[1].entries).toHaveLength(1);
  });
});

describe("formatScheduleCountdown", () => {
  it("says NOW once started and formats d/h/m and h/m/s otherwise", () => {
    const now = 1_000_000_000_000;
    expect(formatScheduleCountdown(now - 1, now)).toBe("NOW");
    expect(formatScheduleCountdown(now + 26 * 3_600_000 + 5 * 60_000, now)).toBe("1d 02h 05m");
    expect(formatScheduleCountdown(now + 2 * 3_600_000 + 3 * 60_000 + 4_000, now)).toBe(
      "2h 03m 04s",
    );
  });
});

describe("formatUpdatedAgo", () => {
  it("prefers minutes, falls back to seconds, null without a fetch", () => {
    const now = 1_000_000_000_000;
    expect(formatUpdatedAgo(now - 3 * 60_000, now)).toBe("3m");
    expect(formatUpdatedAgo(now - 20_000, now)).toBe("20s");
    expect(formatUpdatedAgo(null, now)).toBeNull();
  });
});

describe("factionBadgeKey", () => {
  it("maps known factions and defaults to other", () => {
    expect(factionBadgeKey("Grineer")).toBe("grineer");
    expect(factionBadgeKey("Corpus")).toBe("corpus");
    expect(factionBadgeKey("Infested")).toBe("infested");
    expect(factionBadgeKey("Corrupted")).toBe("corrupted");
    expect(factionBadgeKey("Narmer")).toBe("other");
  });
});
