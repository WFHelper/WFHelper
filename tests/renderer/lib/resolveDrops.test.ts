import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DropRow } from "../../../config/shared/dropTypes.js";
import {
  dropTableQuery,
  dropTableSources,
  latestDropTableSources,
  ownedRelicDropsFirst,
  resolveDrops,
} from "../../../src/lib/resolveDrops.js";
import { relicGroupForDisplayName } from "../../../src/lib/relic/relicInventory.js";
import type { DropInfo } from "../../../src/types/inventory.js";
import type {
  OwnedCounts,
  OwnedQualityCounts,
  RelicDatabase,
  RelicGroup,
  RelicQuality,
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
  it("keeps the incoming order inside the owned and the other group", () => {
    const owned: OwnedCounts = {
      "Axi S3": counts({ radiant: 1 }),
      "Meso P4": counts({ exceptional: 2 }),
    };
    const input = [
      drop("Meso I2 Relic", 25.33),
      drop("Meso P4 Relic", 25.33),
      drop("Neo B5 Relic", 11),
      drop("Axi S3 Relic", 2),
      drop("Grineer Settlement (Mars)", 1),
    ];
    const before = locations(input);
    expect(locations(ownedRelicDropsFirst(input, db, owned))).toEqual([
      "Meso P4 Relic",
      "Axi S3 Relic",
      "Meso I2 Relic",
      "Neo B5 Relic",
      "Grineer Settlement (Mars)",
    ]);
    expect(locations(input)).toEqual(before);
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

  it("keeps the order when no relic is owned or the relic database has not loaded", () => {
    const input = [drop("Meso I2 Relic"), drop("Deimos Vault"), drop("Meso K8 Relic")];
    expect(locations(ownedRelicDropsFirst(input, db, {}))).toEqual(locations(input));
    expect(
      locations(ownedRelicDropsFirst(input, null, { "Meso K8": counts({ intact: 3 }) })),
    ).toEqual(locations(input));
  });
});

describe("resolveDrops", () => {
  it("prefers the item's own drops and falls back to the item database", () => {
    const own = [drop("Meso I2 Relic")];
    const fromDb = [drop("Neo B5 Relic")];
    const itemDb = { "/Part": { drops: fromDb } };
    expect(resolveDrops({ drops: own, uniqueName: "/Part" }, itemDb, null)).toBe(own);
    expect(resolveDrops({ drops: [], uniqueName: "/Part" }, itemDb, null)).toBe(fromDb);
    expect(resolveDrops({ uniqueName: "/Missing" }, itemDb, null)).toEqual([]);
    expect(resolveDrops(null, itemDb, null)).toEqual([]);
  });
});

describe("resolveDrops with a newer relic database", () => {
  const PART = "/Lotus/Types/Recipes/WarframeRecipes/RhinoPrimeHelmetComponent";
  const NAME = "Rhino Prime Neuroptics Blueprint";
  const OTHER = "/Lotus/Types/Recipes/Weapons/WeaponParts/BoltorPrimeStock";
  const QUALITIES: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];
  const UNCOMMON: Record<RelicQuality, number> = {
    intact: 11,
    exceptional: 13,
    flawless: 17,
    radiant: 20,
  };
  const REFINED: Record<RelicQuality, string> = {
    intact: "",
    exceptional: " (Exceptional)",
    flawless: " (Flawless)",
    radiant: " (Radiant)",
  };

  interface RewardSpec {
    name: string;
    uniqueName: string | null;
  }

  function relic(key: string, rewards: RewardSpec[], vaulted = false): RelicGroup {
    const [tier, code] = key.split(" ");
    const qualities: RelicGroup["qualities"] = {};
    for (const quality of QUALITIES) {
      qualities[quality] = {
        uniqueName: `/Lotus/Types/Game/Projections/${key}/${quality}`,
        rewards: rewards.map((reward) => ({
          ...reward,
          rarity: "Uncommon",
          chance: UNCOMMON[quality],
          urlName: null,
          ducats: 45,
        })),
      };
    }
    return { ...makeGroup(tier ?? "", code ?? ""), vaulted, qualities };
  }

  function relicDb(...groups: RelicGroup[]): RelicDatabase {
    return { groups: Object.fromEntries(groups.map((g) => [g.key, g])), byUniqueName: {} };
  }

  function relicRows(key: string, type = NAME): DropInfo[] {
    return QUALITIES.map((quality) => ({
      location: `${key} Relic${REFINED[quality]}`,
      type,
      chance: UNCOMMON[quality],
      rarity: "Uncommon",
    }));
  }

  const part = { name: NAME, uniqueName: PART };
  const partReward = { name: NAME, uniqueName: PART };
  const stockReward = { name: "Boltor Prime Stock", uniqueName: OTHER };
  const listed = relicRows("Lith B1");
  const itemDb = {
    [PART]: { name: NAME, drops: listed },
    [OTHER]: { name: "Boltor Prime Stock", drops: relicRows("Meso S14", "Boltor Prime Stock") },
  };

  it("adds a relic the item data never names, one row per refinement in its format", () => {
    const db = relicDb(
      relic("Lith B1", [partReward], true),
      relic("Axi Z9", [stockReward, partReward]),
      relic("Neo Z8", [stockReward]),
    );
    const merged = resolveDrops({ drops: listed, uniqueName: PART }, itemDb, db);

    expect(merged.filter((d) => d.location.startsWith("Axi Z9"))).toEqual(relicRows("Axi Z9"));
    expect(merged.filter((d) => !d.location.startsWith("Axi Z9"))).toEqual(listed);
    // The item data orders by chance first, so a new relic joins each refinement's run.
    expect(locations(merged)).toEqual([
      "Axi Z9 Relic",
      "Lith B1 Relic",
      "Axi Z9 Relic (Exceptional)",
      "Lith B1 Relic (Exceptional)",
      "Axi Z9 Relic (Flawless)",
      "Lith B1 Relic (Flawless)",
      "Axi Z9 Relic (Radiant)",
      "Lith B1 Relic (Radiant)",
    ]);
    expect(dropTableQuery({ ...part, drops: [] }, { [PART]: { name: NAME } }, db)).toBeNull();
  });

  it("names every relic source as vaulted or not the way the relic database does", () => {
    const vaultState = (db: RelicDatabase) =>
      resolveDrops({ drops: listed, uniqueName: PART }, itemDb, db).map(
        (d) => `${d.location}: ${String(relicGroupForDisplayName(db, d.location)?.vaulted)}`,
      );
    const before = relicDb(relic("Lith B1", [partReward], true), relic("Axi Z9", [partReward]));
    const after = relicDb(relic("Lith B1", [partReward]), relic("Axi Z9", [partReward], true));

    expect(vaultState(before)).toContain("Lith B1 Relic: true");
    expect(vaultState(before)).toContain("Axi Z9 Relic (Radiant): false");
    expect(vaultState(after)).toContain("Lith B1 Relic: false");
    expect(vaultState(after)).toContain("Axi Z9 Relic (Radiant): true");
  });

  it("changes nothing while every relic that lists the part is one the item data names", () => {
    const own = { drops: listed, uniqueName: PART };
    // Meso S14 lists the part here, but the item data only names it for another item.
    const bundled = relicDb(relic("Lith B1", [partReward]), relic("Meso S14", [partReward]));

    expect(resolveDrops(own, itemDb, bundled)).toBe(listed);
    expect(resolveDrops(own, itemDb, null)).toBe(listed);
    expect(resolveDrops({ drops: listed }, itemDb, relicDb(relic("Axi Z9", [partReward])))).toBe(
      listed,
    );
    // A part's own entry can list nothing while its parent's component row names the relics.
    const parentOnly = {
      ...itemDb,
      [PART]: { name: NAME },
      "/Lotus/Powersuits/Rhino/RhinoPrime": {
        name: "Rhino Prime",
        components: [{ drops: listed }],
      },
    };
    expect(resolveDrops({ ...part, drops: [] }, parentOnly, bundled)).toEqual([]);
    expect(dropTableQuery({ ...part, drops: [] }, parentOnly, bundled)).toBe(NAME);
    // A newer relic must not become that entry's only listed source.
    const newer = relicDb(
      relic("Lith B1", [partReward]),
      relic("Meso S14", [partReward]),
      relic("Axi Z9", [partReward]),
    );
    expect(resolveDrops({ ...part, drops: [] }, parentOnly, newer)).toEqual([]);
    expect(dropTableQuery({ ...part, drops: [] }, parentOnly, newer)).toBe(NAME);
  });

  it("matches the reward by uniqueName, its Blueprint spelling, or its name", () => {
    const db = relicDb(
      relic("Axi Z1", [
        { name: "Neuroptics", uniqueName: PART.replace(/Component$/, "Blueprint") },
      ]),
      relic("Axi Z2", [{ name: NAME, uniqueName: "/Lotus/StoreItems/RhinoPrimeHelmet" }]),
      relic("Axi Z3", [{ name: NAME, uniqueName: null }]),
      relic("Axi Z4", [{ name: "Rhino Prime Chassis Blueprint", uniqueName: "/Chassis" }]),
    );
    const added = resolveDrops({ drops: listed, uniqueName: PART }, itemDb, db)
      .filter((d) => !listed.includes(d) && !/\(/.test(d.location))
      .map((d) => d.location);

    expect(added.sort()).toEqual(["Axi Z1 Relic", "Axi Z2 Relic", "Axi Z3 Relic"]);
  });

  it("gives a weapon ingredient the new relics of the parts it already lists", () => {
    const BRONCO = "/Lotus/Weapons/Tenno/Pistol/BroncoPrime";
    const barrel = relicRows("Axi E2", "Bronco Prime Barrel");
    const db = relicDb(
      relic("Axi E2", [{ name: "Bronco Prime Barrel", uniqueName: "/Barrel" }]),
      relic("Lith Z4", [{ name: "Bronco Prime Barrel", uniqueName: "/Barrel" }]),
    );
    const merged = resolveDrops(
      { drops: barrel, uniqueName: BRONCO },
      { [BRONCO]: { name: "Bronco Prime" } },
      db,
    );

    expect(merged.filter((d) => d.location.startsWith("Lith Z4"))).toEqual(
      relicRows("Lith Z4", "Bronco Prime Barrel"),
    );
  });
});

describe("drop table fallback", () => {
  const OROKIN_CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
  const rows: DropRow[] = [
    { item: "Orokin Cell", place: "Saturn Proxima", rarity: "Rare", chance: 2.5, kind: "enemy" },
    { item: "2X Orokin Cell", place: "Sortie", rarity: "Common", chance: null, kind: "sortie" },
  ];
  let dropSourcesForItem = vi.fn<(name: string) => Promise<DropRow[]>>();

  beforeEach(() => {
    dropSourcesForItem = vi.fn(() => Promise.resolve(rows));
    vi.stubGlobal("window", { api: { dropSourcesForItem } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives an ingredient without drops the drop table rows under its English name", async () => {
    const itemDb = { [OROKIN_CELL]: { name: "Orokin Cell", drops: [] } };
    const query = dropTableQuery({ name: "Cellule Orokin", uniqueName: OROKIN_CELL }, itemDb, null);
    expect(query).toBe("Orokin Cell");

    const drops = await dropTableSources(query ?? "");
    expect(drops).toEqual([
      { location: "Saturn Proxima", type: "Orokin Cell", chance: 2.5, rarity: "Rare" },
      { location: "Sortie", type: "2X Orokin Cell", chance: 0, rarity: "Common" },
    ]);
    expect(await dropTableSources("orokin cell")).toBe(drops);
    expect(dropSourcesForItem.mock.calls).toEqual([["Orokin Cell"]]);
  });

  it("leaves an ingredient whose item data lists a source alone", () => {
    const own = [drop("Meso I2 Relic")];
    const itemDb = { [OROKIN_CELL]: { name: "Orokin Cell", drops: [drop("Neo B5 Relic")] } };
    expect(dropTableQuery({ name: "Orokin Cell", drops: own }, itemDb, null)).toBeNull();
    expect(
      dropTableQuery({ name: "Orokin Cell", uniqueName: OROKIN_CELL }, itemDb, null),
    ).toBeNull();
    expect(dropTableQuery(null, itemDb, null)).toBeNull();
  });

  it("shows nothing when the drop data fails, and asks again next time", async () => {
    dropSourcesForItem.mockRejectedValueOnce(new Error("offline"));
    expect(await dropTableSources("Neurodes")).toEqual([]);
    expect((await dropTableSources("Neurodes")).map((d) => d.location)).toEqual([
      "Saturn Proxima",
      "Sortie",
    ]);
    expect(dropSourcesForItem).toHaveBeenCalledTimes(2);
  });

  it("asks again after no rows, since a failed first drop download also answers none", async () => {
    dropSourcesForItem.mockResolvedValueOnce([]);
    expect(await dropTableSources("Plastids")).toEqual([]);
    expect((await dropTableSources("Plastids")).map((d) => d.location)).toEqual([
      "Saturn Proxima",
      "Sortie",
    ]);
    expect(dropSourcesForItem).toHaveBeenCalledTimes(2);
  });

  it("keeps the ingredient asked for last when an earlier one answers later", async () => {
    let answerEarlier: (rows: DropRow[]) => void = () => {};
    dropSourcesForItem.mockImplementationOnce(
      () => new Promise<DropRow[]>((resolve) => (answerEarlier = resolve)),
    );
    const shown: string[] = [];
    const load = latestDropTableSources((query) => shown.push(query));

    const earlier = load("Rubedo");
    await load("Tellurium");
    answerEarlier(rows);
    await earlier;

    expect(shown).toEqual(["Tellurium"]);
  });
});
