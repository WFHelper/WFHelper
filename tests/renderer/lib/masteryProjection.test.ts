import { describe, expect, it } from "vitest";

import { en } from "../../../src/i18n/en.js";
import {
  easyMasteryPotentialRank,
  masteryProjectionSubtext,
} from "../../../src/lib/masteryProjection.js";
import type { Translator } from "../../../src/lib/i18n.js";

// Mirrors the app translator so the assertions stay against real English copy.
const t: Translator = (key, params = {}) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ""));

describe("masteryProjectionSubtext", () => {
  it("separates banked rank support from ready Foundry XP", () => {
    expect(masteryProjectionSubtext(t, 22, 1_759_845, 36_000, "en")).toBe(
      `Banked XP supports MR 26 · ${Number(36_000).toLocaleString("en")} XP ready in Foundry`,
    );
  });

  it("credits Foundry XP when it crosses the next threshold", () => {
    expect(masteryProjectionSubtext(t, 25, 1_680_000, 20_000, "en")).toBe(
      `Foundry raises potential to MR 26 (+${Number(20_000).toLocaleString("en")} XP)`,
    );
  });

  it("shows both banked support and a further Foundry projection", () => {
    expect(masteryProjectionSubtext(t, 24, 1_680_000, 20_000, "en")).toBe(
      `Banked XP supports MR 25 · Foundry raises potential to MR 26 (+${Number(20_000).toLocaleString("en")} XP)`,
    );
  });

  it("only reports ready XP when no rank threshold changes", () => {
    expect(masteryProjectionSubtext(t, 25, 1_600_000, 20_000, "en")).toBe(
      `${Number(20_000).toLocaleString("en")} XP ready in Foundry`,
    );
  });

  it("formats ready XP for the selected locale", () => {
    expect(masteryProjectionSubtext(t, 25, 1_600_000, 20_000, "de")).toBe(
      `${Number(20_000).toLocaleString("de")} XP ready in Foundry`,
    );
  });

  it("handles legendary-rank thresholds", () => {
    expect(masteryProjectionSubtext(t, 29, 2_300_000, 100_000, "en")).toBe(
      `Banked XP supports MR 30 · Foundry raises potential to MR 31 (+${Number(100_000).toLocaleString("en")} XP)`,
    );
  });

  it("returns no projection when nothing is banked or ready", () => {
    expect(masteryProjectionSubtext(t, 25, 1_600_000, 0, "en")).toBeNull();
  });

  // Discord (Silber): MR 6 with 184,968 XP and an empty Foundry showed nothing.
  it("keeps the banked line when the Foundry has nothing to claim", () => {
    expect(masteryProjectionSubtext(t, 6, 184_968, 0, "en")).toBe("Banked XP supports MR 8");
    expect(masteryProjectionSubtext(t, 5, 157_838, 15_000, "en")).toBe(
      `Banked XP supports MR 7 · Foundry raises potential to MR 8 (+${Number(15_000).toLocaleString("en")} XP)`,
    );
  });
});

describe("easyMasteryPotentialRank", () => {
  // Issue 23: an MR 28 account with 40,600 easy XP was told it could reach MR 28.
  it("stays silent when the easy items do not cross a rank", () => {
    expect(easyMasteryPotentialRank(28, 2_000_000, 40_600)).toBeNull();
  });

  it("names the rank the easy items actually unlock", () => {
    expect(easyMasteryPotentialRank(25, 1_600_000, 200_000)).toBe(26);
  });

  it("measures against banked XP, not the untested profile rank", () => {
    // Tests pending: the XP already covers a higher rank, so a small top-up
    // that lands inside it is not news.
    expect(easyMasteryPotentialRank(22, 1_759_845, 1_000)).toBeNull();
  });

  it("returns null without a profile rank or XP total", () => {
    expect(easyMasteryPotentialRank(null, 1_600_000, 50_000)).toBeNull();
    expect(easyMasteryPotentialRank(25, null, 50_000)).toBeNull();
  });
});
