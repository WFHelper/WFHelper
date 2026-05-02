import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import { formatWfmAssetUrl } from "../../config/shared/wfm";
import {
  getBestAttributes as getMainBestAttributes,
  setRivenGoodRollsForTest,
} from "../../services/rivenBestAttributes";

describe("Tier 3 shared helpers", () => {
  it("aggregates component ownership across inventory slices", () => {
    const owned = aggregateComponentOwnership(
      [{ ItemType: "/A", ItemCount: 2 }, { ItemType: "/B" }],
      [{ ItemType: "/A", ItemCount: 3 }, { ItemType: "/D", ItemCount: 0 }],
      [{ ItemType: "/C" }, { ItemType: "/B" }],
    );

    expect([...owned.entries()].sort()).toEqual([
      ["/A", 5],
      ["/B", 2],
      ["/C", 1],
      ["/D", 0],
    ]);
  });

  it("formats WFM asset URLs", () => {
    expect(formatWfmAssetUrl("https://example.com/icon.png")).toBe("https://example.com/icon.png");
    expect(formatWfmAssetUrl("icons/foo.png")).toBe("https://warframe.market/static/assets/icons/foo.png");
    expect(formatWfmAssetUrl("")).toBeNull();
    expect(formatWfmAssetUrl(null)).toBeNull();
  });

  it("resolves per-weapon best attributes from the 44bananas dataset", () => {
    setRivenGoodRollsForTest({
      lex: {
        goodAttrs: [{ mandatory: ["WeaponCritDamageMod"], optional: [] }],
        acceptedBadAttrs: ["WeaponZoomFovMod"],
      },
    });
    const lex = getMainBestAttributes("Lex");
    expect(lex).not.toBeNull();
    expect(lex?.positives).toContain("Critical Damage");
    expect(lex?.negatives).toContain("Zoom");
    // Variant fallback: "Lex Prime" not in the sheet, but "Lex" is.
    expect(getMainBestAttributes("Lex Prime")).not.toBeNull();
    // Unknown weapon→null (no fallback).
    expect(getMainBestAttributes("NotAWeaponName")).toBeNull();
  });
});
