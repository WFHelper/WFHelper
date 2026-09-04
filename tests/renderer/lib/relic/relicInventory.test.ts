import { describe, expect, it } from "vitest";

import { relicGroupForDisplayName } from "../../../../src/lib/relic/relicInventory.js";
import type { RelicDatabase, RelicGroup } from "../../../../src/types/relics.js";

function makeGroup(tier: string, code: string): RelicGroup {
  return {
    key: `${tier} ${code}`,
    name: `${tier} ${code}`,
    tier,
    code,
    imageUrl: null,
    qualities: {},
  };
}

const db: RelicDatabase = {
  groups: {
    "Lith A1": makeGroup("Lith", "A1"),
    "Meso B2": makeGroup("Meso", "B2"),
    "Requiem I": makeGroup("Requiem", "I"),
  },
  byUniqueName: {},
};

describe("relicGroupForDisplayName", () => {
  it("resolves the drop-table spelling", () => {
    expect(relicGroupForDisplayName(db, "Lith A1 Relic")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Requiem I Relic")?.key).toBe("Requiem I");
  });

  it("tolerates a missing suffix, odd spacing and case", () => {
    expect(relicGroupForDisplayName(db, "meso b2")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "  LITH   a1   relic ")?.key).toBe("Lith A1");
  });

  it("drops a refinement in parentheses in either position", () => {
    expect(relicGroupForDisplayName(db, "Lith A1 Relic (Radiant)")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Lith A1 (Intact) Relic")?.key).toBe("Lith A1");
  });

  it("resolves the acquisition-list spellings and skips a plain location", () => {
    // The acquisition-list spellings DropsList feeds in.
    expect(relicGroupForDisplayName(db, "Lith A1 Relic (Intact)")?.key).toBe("Lith A1");
    expect(relicGroupForDisplayName(db, "Meso B2 Relic (Exceptional)")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Meso B2 Relic (Flawless)")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Meso B2")?.key).toBe("Meso B2");
    expect(relicGroupForDisplayName(db, "Grineer Settlement (Mars)")).toBeNull();
  });

  it("returns null for an unknown relic, empty input or no database", () => {
    expect(relicGroupForDisplayName(db, "Axi Z9 Relic")).toBeNull();
    expect(relicGroupForDisplayName(db, "Relic")).toBeNull();
    expect(relicGroupForDisplayName(db, "")).toBeNull();
    expect(relicGroupForDisplayName(null, "Lith A1 Relic")).toBeNull();
  });
});
