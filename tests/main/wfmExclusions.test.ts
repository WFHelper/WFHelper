import { describe, expect, it } from "vitest";

import { isRankedMarketItem } from "../../config/shared/wfmExclusions";

describe("isRankedMarketItem", () => {
  it("offers rank views for ordinary mods and arcanes", () => {
    expect(isRankedMarketItem("mods", "Serration", "serration")).toBe(true);
    expect(isRankedMarketItem("arcanes", "Arcane Energize", "arcane_energize")).toBe(true);
  });

  it("never offers rank views for non-ranked groups", () => {
    expect(isRankedMarketItem("relics", "Axi A1 Relic", "axi_a1_relic")).toBe(false);
    expect(isRankedMarketItem("all_parts", "Ash Prime Set", "ash_prime_set")).toBe(false);
    expect(isRankedMarketItem(null, "Unknown", null)).toBe(false);
  });

  it("drops rank views for veiled riven mods, which WFM lists without a rank", () => {
    expect(isRankedMarketItem("mods", "Rifle Riven Mod (Veiled)", "rifle_riven_mod_veiled")).toBe(
      false,
    );
    // A market-order item joins the mod group but carries the subtype suffix, so
    // only the slug still marks it as rankless.
    expect(
      isRankedMarketItem("mods", "Rifle Riven Mod (Veiled) (Unrevealed)", "rifle_riven_mod_veiled"),
    ).toBe(false);
  });

  it("drops rank views for Blood For mods, also rankless on WFM", () => {
    expect(isRankedMarketItem("mods", "Blood For Ammo", "blood_for_ammo")).toBe(false);
  });
});
