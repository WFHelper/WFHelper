import { describe, expect, it } from "vitest";

import { ownedRelicDropsFirst, resolveDrops } from "../../../src/lib/resolveDrops.js";
import type { DropInfo } from "../../../src/types/inventory.js";
import type {
  OwnedCounts,
  OwnedQualityCounts,
  RelicDatabase,
  RelicGroup,
} from "../../../src/types/relics.js";

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
  groups: Object.fromEntries(
    ["Meso I2", "Meso K8", "Meso P4", "Neo B5", "Axi S3"].map((key) => {
      const [tier, code] = key.split(" ");
      return [key, makeGroup(tier ?? "", code ?? "")];
    }),
  ),
  byUniqueName: {},
};

function counts(partial: Partial<OwnedQualityCounts>): OwnedQualityCounts {
  return { intact: 0, exceptional: 0, flawless: 0, radiant: 0, ...partial };
}

function drop(location: string, chance = 25.33): DropInfo {
  return { location, chance, rarity: "Common" };
}

const locations = (drops: DropInfo[]): string[] => drops.map((d) => d.location);

describe("ownedRelicDropsFirst", () => {
  it("moves an owned relic ahead of unowned relics", () => {
    const owned: OwnedCounts = { "Meso K8": counts({ intact: 12 }) };
    const sorted = ownedRelicDropsFirst(
      [drop("Meso I2 Relic"), drop("Meso K8 Relic"), drop("Meso P4 Relic")],
      db,
      owned,
    );
    expect(locations(sorted)).toEqual(["Meso K8 Relic", "Meso I2 Relic", "Meso P4 Relic"]);
  });

  it("keeps the incoming order inside the owned and the other group", () => {
    const owned: OwnedCounts = {
      "Axi S3": counts({ radiant: 1 }),
      "Meso P4": counts({ exceptional: 2 }),
    };
    const sorted = ownedRelicDropsFirst(
      [
        drop("Meso I2 Relic", 25.33),
        drop("Meso P4 Relic", 25.33),
        drop("Neo B5 Relic", 11),
        drop("Axi S3 Relic", 2),
        drop("Grineer Settlement (Mars)", 1),
      ],
      db,
      owned,
    );
    expect(locations(sorted)).toEqual([
      "Meso P4 Relic",
      "Axi S3 Relic",
      "Meso I2 Relic",
      "Neo B5 Relic",
      "Grineer Settlement (Mars)",
    ]);
  });

  it("counts any refinement above zero and ignores an all-zero entry", () => {
    const owned: OwnedCounts = {
      "Meso I2": counts({}),
      "Neo B5": counts({ flawless: 1 }),
    };
    const sorted = ownedRelicDropsFirst(
      [drop("Meso I2 Relic"), drop("Neo B5 Relic (Radiant)"), drop("Meso P4")],
      db,
      owned,
    );
    expect(locations(sorted)).toEqual(["Neo B5 Relic (Radiant)", "Meso I2 Relic", "Meso P4"]);
  });

  it("leaves the order unchanged when no relic is owned", () => {
    const input = [drop("Meso I2 Relic"), drop("Deimos Vault"), drop("Meso P4 Relic")];
    expect(locations(ownedRelicDropsFirst(input, db, {}))).toEqual(locations(input));
  });

  it("keeps non-relic sources in place and does not mutate the input", () => {
    const input = [drop("Void Trader"), drop("Grineer Settlement (Mars)"), drop("Meso K8 Relic")];
    const sorted = ownedRelicDropsFirst(input, db, { "Meso K8": counts({ intact: 1 }) });
    expect(locations(sorted)).toEqual([
      "Meso K8 Relic",
      "Void Trader",
      "Grineer Settlement (Mars)",
    ]);
    expect(locations(input)).toEqual(["Void Trader", "Grineer Settlement (Mars)", "Meso K8 Relic"]);
  });

  it("keeps the order while the relic database has not loaded", () => {
    const input = [drop("Meso I2 Relic"), drop("Meso K8 Relic")];
    const sorted = ownedRelicDropsFirst(input, null, { "Meso K8": counts({ intact: 3 }) });
    expect(locations(sorted)).toEqual(["Meso I2 Relic", "Meso K8 Relic"]);
  });
});

describe("resolveDrops", () => {
  it("prefers the item's own drops and falls back to the item database", () => {
    const own = [drop("Meso I2 Relic")];
    const fromDb = [drop("Neo B5 Relic")];
    const itemDb = { "/Part": { drops: fromDb } };
    expect(resolveDrops({ drops: own, uniqueName: "/Part" }, itemDb)).toBe(own);
    expect(resolveDrops({ drops: [], uniqueName: "/Part" }, itemDb)).toBe(fromDb);
    expect(resolveDrops({ uniqueName: "/Missing" }, itemDb)).toEqual([]);
    expect(resolveDrops(null, itemDb)).toEqual([]);
  });
});
