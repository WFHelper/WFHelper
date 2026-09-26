import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setGameLocale } from "../../services/gameLocale";
import * as itemDb from "../../services/itemDatabase";
import { getRelicDatabase } from "../../services/relicService";
import { relicNameFromLabel } from "../../src/lib/relic/relicInventory.js";
import { withRelicDbSources } from "../../src/lib/relic/relicDropSources.js";
import type { DropInfo, ItemDbEntry } from "../../src/types/inventory.js";
import type { RelicDatabase } from "../../src/types/relics.js";

const SERRATION = "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod";

beforeAll(() => {
  setGameLocale("en");
  itemDb.buildDatabase();
});

afterAll(() => {
  setGameLocale("en");
});

describe("renderer item lookup", () => {
  it("hands every window the same projection until something changes", () => {
    expect(itemDb.getRendererLookup()).toBe(itemDb.getRendererLookup());
  });

  it("is rebuilt for a game language change and again on the way back", () => {
    const english = itemDb.getRendererLookup();
    setGameLocale("de");
    const german = itemDb.getRendererLookup();
    expect(german).not.toBe(english);
    expect(german[SERRATION].displayName).toBe("Einkerbung");

    setGameLocale("en");
    const back = itemDb.getRendererLookup();
    expect(back).not.toBe(german);
    expect(back[SERRATION].displayName).toBeUndefined();
  });

  it("is rebuilt with the database", () => {
    const before = itemDb.getRendererLookup();
    itemDb.buildDatabase();
    const after = itemDb.getRendererLookup();
    expect(after).not.toBe(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  // The component panel lists every source behind "View all N sources".
  it("keeps every drop row of a component", () => {
    const components = Object.values(itemDb.getRendererLookup()).flatMap((e) => e.components);
    expect(components.some((c) => c.drops.length > 20)).toBe(true);
  });

  it("flags only the weapons the item data tags as Incarnon", () => {
    const lookup = itemDb.getRendererLookup();
    expect(
      lookup["/Lotus/Weapons/Tenno/Zariman/Pistols/HeavyPistol/ZarimanHeavyPistol"]?.incarnon,
    ).toBe(true);
    expect(lookup["/Lotus/Weapons/Thanotech/EntFistIncarnon/EntFistIncarnon"]?.incarnon).toBe(true);
    expect(lookup["/Lotus/Weapons/Tenno/Pistol/HeavyPistol"]?.incarnon).toBeUndefined();
  });
});

describe("relic drop sources against the bundled relic database", () => {
  const isRelicRow = (drop: DropInfo): boolean => /\bRelic\b/.test(drop.location);

  // Every list resolveDrops can hand the merge: each entry's and each component's own.
  function dropLists(lookup: Record<string, ItemDbEntry>) {
    return Object.entries(lookup).flatMap(([uniqueName, entry]) => [
      { drops: entry.drops ?? [], uniqueName },
      ...(entry.components ?? []).flatMap((component) =>
        component.uniqueName
          ? [{ drops: component.drops ?? [], uniqueName: component.uniqueName }]
          : [],
      ),
    ]);
  }

  it("leaves every item and component list exactly as the item data has it", () => {
    const lookup = itemDb.getRendererLookup() as unknown as Record<string, ItemDbEntry>;
    const relics = getRelicDatabase() as unknown as RelicDatabase;
    const lists = dropLists(lookup);
    const changed = lists.filter(
      ({ drops, uniqueName }) => withRelicDbSources(drops, uniqueName, lookup, relics) !== drops,
    );

    // 24812 lists, 640 of them with relic rows, in @wfcd/items 1.1276.6.
    expect(lists.filter(({ drops }) => drops.some(isRelicRow)).length).toBeGreaterThan(500);
    expect(changed.map(({ uniqueName }) => uniqueName)).toEqual([]);
  });

  it("adds a relic only a newer set lists, in the rows the item data gives its twin", () => {
    const lookup = itemDb.getRendererLookup() as unknown as Record<string, ItemDbEntry>;
    const relics = getRelicDatabase() as unknown as RelicDatabase;
    const part = dropLists(lookup).find(
      ({ drops, uniqueName }) => lookup[uniqueName] && drops.some(isRelicRow),
    );
    const drops = part?.drops ?? [];
    const twinName = relicNameFromLabel(drops.find(isRelicRow)?.location ?? "");
    const twin = relics.groups[twinName];
    expect(twin).toBeDefined();
    const newer: RelicDatabase = {
      groups: {
        ...relics.groups,
        "Axi Z99": { ...twin, key: "Axi Z99", name: "Axi Z99", code: "Z99" },
      },
      byUniqueName: relics.byUniqueName,
    };

    const merged = withRelicDbSources(drops, part?.uniqueName ?? "", lookup, newer);
    const renamed = drops
      .filter((drop) => relicNameFromLabel(drop.location) === twinName)
      .map((drop) => ({ ...drop, location: drop.location.replace(twinName, "Axi Z99") }));
    const byLocation = (a: DropInfo, b: DropInfo) => a.location.localeCompare(b.location);

    expect(renamed.length).toBeGreaterThan(0);
    expect(merged.filter((drop) => drop.location.startsWith("Axi Z99 ")).sort(byLocation)).toEqual(
      renamed.sort(byLocation),
    );
    expect(merged.filter((drop) => !drop.location.startsWith("Axi Z99 "))).toEqual(drops);
  });
});
