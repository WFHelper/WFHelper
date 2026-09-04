import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flattenForTest, searchDrops, setRowsForTest, type DropRow } from "../../services/dropData";
// @ts-expect-error -- plain build script module, no type declarations
import { dojoResearchEntries } from "../../scripts/dojo-research/parseResearchModule.mjs";

let tmpDir = "";
// Non-null swaps the bundled dojo table for this text, to exercise a bad file.
let dojoFileOverride: string | null = null;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (dojoFileOverride !== null && String(file).endsWith("dojoResearch.json")) {
      return dojoFileOverride;
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  const patched = { ...actual, readFileSync };
  return { ...patched, default: patched };
});

describe("dropData.flatten", () => {
  const data = {
    missionRewards: {
      Mercury: {
        Apollodorus: {
          gameMode: "Survival",
          rewards: { C: [{ itemName: "Vitus", rarity: "Rare", chance: 7 }] },
        },
      },
    },
    relics: [
      {
        tier: "Axi",
        relicName: "A1",
        state: "Intact",
        rewards: [{ itemName: "Nikana Prime Blueprint", rarity: "Rare", chance: 2 }],
      },
      {
        tier: "Axi",
        relicName: "A1",
        state: "Radiant",
        rewards: [{ itemName: "Nikana Prime Blueprint", rarity: "Rare", chance: 10 }],
      },
    ],
    modLocations: [
      {
        modName: "Serration",
        enemies: [{ enemyName: "Grineer Lancer", rarity: "Common", chance: 11.06 }],
      },
    ],
    enemyModTables: [
      { enemyName: "Screamer", mods: [{ modName: "Vitality", rarity: "Uncommon", chance: 12.5 }] },
    ],
    resourceByAvatar: [
      {
        source: "Motherboard Cluster",
        items: [{ item: "Techrot Motherboard", rarity: "Common", chance: 100 }],
      },
    ],
    syndicates: {
      "Kahl's Garrison": [
        {
          item: "Styanax Systems Blueprint",
          rarity: "Common",
          chance: 100,
          place: "Kahl's Garrison, Encampment",
        },
      ],
    },
    sortieRewards: [{ itemName: "Riven Mod", rarity: "Rare", chance: 3 }],
    keyRewards: [
      {
        keyName: "Archon Amar",
        rewards: { A: [{ itemName: "Crimson Archon Shard", rarity: "Common", chance: 100 }] },
      },
    ],
    solarisBountyRewards: [
      {
        bountyLevel: "Level 5 - 15 Orb Vallis Bounty",
        rewards: {
          A: [{ itemName: "Endo", rarity: "Common", chance: 25, stage: "Stage 1" }],
        },
      },
    ],
    transientRewards: [
      { objectiveName: "Arbitrations", rewards: [{ itemName: "Vitus Essence", chance: 100 }] },
    ],
  };

  const rows = flattenForTest(data);
  const find = (item: string): DropRow | undefined => rows.find((r) => r.item === item);

  it("flattens mission rewards with rotation in the place", () => {
    expect(find("Vitus")).toEqual({
      item: "Vitus",
      place: "Apollodorus (Mercury), Rotation C",
      rarity: "Rare",
      chance: 7,
      kind: "mission",
    });
  });

  it("tags every row with the table it came from", () => {
    expect(find("Vitus")?.kind).toBe("mission");
    expect(find("Vitus Essence")?.kind).toBe("mission"); // transient game modes
    expect(find("Nikana Prime Blueprint")?.kind).toBe("relic");
    expect(find("Serration")?.kind).toBe("enemy");
    expect(find("Vitality")?.kind).toBe("enemy");
    expect(find("Techrot Motherboard")?.kind).toBe("enemy"); // resourceByAvatar
    expect(find("Styanax Systems Blueprint")?.kind).toBe("syndicate");
    expect(find("Riven Mod")?.kind).toBe("sortie");
    expect(find("Crimson Archon Shard")?.kind).toBe("quest");
    expect(find("Endo")?.kind).toBe("bounty");
  });

  it("keeps the bounty level label as the place so live jobs can be matched", () => {
    expect(find("Endo")?.place).toBe("Level 5 - 15 Orb Vallis Bounty, Rotation A (Stage 1)");
  });

  it("keeps only the Intact relic state", () => {
    const nikana = rows.filter((r) => r.item === "Nikana Prime Blueprint");
    expect(nikana).toHaveLength(1);
    expect(nikana[0].place).toBe("Axi A1 Relic");
    expect(nikana[0].chance).toBe(2);
  });

  it("maps item->enemy (modLocations) and enemy->item (enemyModTables)", () => {
    expect(find("Serration")?.place).toBe("Grineer Lancer");
    expect(find("Vitality")?.place).toBe("Screamer");
  });

  it("handles resourceByAvatar (item field) and pre-placed syndicates", () => {
    expect(find("Techrot Motherboard")?.place).toBe("Motherboard Cluster");
    expect(find("Styanax Systems Blueprint")?.place).toBe("Kahl's Garrison, Encampment");
  });
});

describe("dropData.searchDrops", () => {
  setRowsForTest([
    {
      item: "Vitus Essence",
      place: "Arbitrations, Rotation C",
      rarity: "Uncommon",
      chance: 10,
      kind: "mission",
    },
    {
      item: "Vitus Essence",
      place: "Arbitration Shield Drone",
      rarity: "Common",
      chance: 6,
      kind: "enemy",
    },
    { item: "Survivalist Vitus", place: "Elsewhere", rarity: "Rare", chance: 1, kind: "other" },
  ]);

  it("ranks prefix matches above mid-word and returns total", () => {
    const res = searchDrops("vitus", "item");
    expect(res.total).toBe(3);
    expect(res.rows[0].item).toBe("Vitus Essence"); // prefix beats "Survivalist Vitus"
  });

  it("searches by place when mode is place", () => {
    const res = searchDrops("arbitration", "place");
    expect(res.total).toBe(2);
  });

  it("returns nothing for an empty query", () => {
    expect(searchDrops("  ", "item")).toEqual({ rows: [], total: 0 });
  });
});

// Rows are set per test here: the sibling describe above seeds its own set at
// collection time, so replacing them in a describe body would clobber it.
describe("dropData.searchDrops enemy mode", () => {
  beforeEach(() => {
    setRowsForTest([
      {
        item: "Vitus Essence",
        place: "Arbitrations, Rotation C",
        rarity: "Uncommon",
        chance: 10,
        kind: "mission",
      },
      {
        item: "Vitus Essence",
        place: "Arbitration Shield Drone",
        rarity: "Common",
        chance: 6,
        kind: "enemy",
      },
      {
        item: "Cleaving Whirlwind",
        place: "Arid Butcher",
        rarity: "Rare",
        chance: 5,
        kind: "enemy",
      },
      { item: "Sundering Weave", place: "Butcher", rarity: "Rare", chance: 1.5, kind: "enemy" },
      {
        item: "Amprex Blueprint",
        place: "Energy Lab",
        rarity: "Common",
        chance: 100,
        kind: "dojo",
      },
    ]);
  });

  it("drops the non-enemy rows a place search would also return", () => {
    expect(searchDrops("arbitration", "place").total).toBe(2);
    const res = searchDrops("arbitration", "enemy");
    expect(res.total).toBe(1);
    expect(res.rows[0].place).toBe("Arbitration Shield Drone");
  });

  it("ranks prefix above word-start, as the place search does", () => {
    // Arid Butcher has the higher chance, so only the rank rule can order these.
    expect(searchDrops("butcher", "enemy").rows.map((row) => row.place)).toEqual([
      "Butcher",
      "Arid Butcher",
    ]);
  });

  it("leaves the dojo search field to the place mode", () => {
    expect(searchDrops("dojo", "place").total).toBe(1);
    expect(searchDrops("dojo", "enemy").total).toBe(0);
    expect(searchDrops("energy lab", "enemy").total).toBe(0);
  });

  it("searches the item field in item mode, enemy rows included", () => {
    expect(searchDrops("vitus", "item").total).toBe(2);
  });
});

// Matches CACHE_VERSION in services/dropData.ts; a bump must fail loudly here.
const CACHED_UPSTREAM = {
  version: 2,
  hash: "cachedhash",
  updatedAt: "",
  rows: [
    {
      item: "Vitus Essence",
      place: "Arbitrations, Rotation C",
      rarity: "Uncommon",
      chance: 10,
      kind: "mission",
    },
  ],
};

type DropData = typeof import("../../services/dropData");

async function freshDropData(): Promise<DropData> {
  vi.resetModules();
  return import("../../services/dropData");
}

const dojoRowsFor = (dd: DropData, query: string): DropRow[] =>
  dd.searchDrops(query, "item").rows.filter((row) => row.kind === "dojo");

describe("dropData dojo research", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dropdata-"));
    fs.writeFileSync(path.join(tmpDir, "drop-data-cache.json"), JSON.stringify(CACHED_UPSTREAM));
  });

  afterEach(() => {
    dojoFileOverride = null;
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges the bundled table once onto rows restored from disk", async () => {
    const dd = await freshDropData();
    expect(dd.loadFromDisk()).toBe(true);

    const dojo = dojoRowsFor(dd, "Squad Energy Restore (Large) Blueprint");
    expect(dojo).toEqual([
      {
        item: "Squad Energy Restore (Large) Blueprint",
        place: "Energy Lab",
        rarity: "Common",
        chance: 100,
        kind: "dojo",
      },
    ]);
    expect(dd.searchDrops("vitus", "item").total).toBe(1);
  });

  it("merges the bundled table once after an upstream refresh, and never caches it", async () => {
    vi.stubGlobal("fetch", async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes("info.json")
          ? { hash: "fresh" }
          : {
              syndicates: {
                "Kahl's Garrison": [
                  {
                    item: "Styanax Systems Blueprint",
                    rarity: "Common",
                    chance: 100,
                    place: "Hub",
                  },
                ],
              },
            },
    }));

    const dd = await freshDropData();
    await dd.refreshFromUpstream();

    expect(dojoRowsFor(dd, "Squad Energy Restore (Large) Blueprint")).toHaveLength(1);
    expect(dd.searchDrops("styanax", "item").total).toBe(1);

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "drop-data-cache.json"), "utf8"),
    ) as typeof CACHED_UPSTREAM;
    expect(written.rows.some((row) => row.kind === "dojo")).toBe(false);
  });

  it("finds a lab by name and by the word dojo, without showing it in the place", async () => {
    const dd = await freshDropData();
    dd.loadFromDisk();

    expect(dd.searchDrops("energy lab", "place").total).toBeGreaterThan(0);
    const byKind = dd.searchDrops("dojo", "place");
    expect(byKind.total).toBeGreaterThan(0);
    expect(byKind.rows.every((row) => row.kind === "dojo")).toBe(true);
    expect(byKind.rows.every((row) => !/dojo/i.test(row.place))).toBe(true);
  });

  it("serves zero dojo rows when the bundled file is unreadable", async () => {
    dojoFileOverride = "{ not json";
    const dd = await freshDropData();
    dd.loadFromDisk();

    expect(dd.searchDrops("dojo", "place").total).toBe(0);
    expect(dd.searchDrops("vitus", "item").total).toBe(1);
  });

  it("ignores a table with no entries array and skips malformed entries", async () => {
    dojoFileOverride = JSON.stringify({ entries: "nope" });
    const noEntries = await freshDropData();
    noEntries.loadFromDisk();
    expect(noEntries.searchDrops("dojo", "place").total).toBe(0);

    dojoFileOverride = JSON.stringify({
      entries: [
        { item: "Amprex Blueprint", lab: "Energy Lab" },
        { item: 5, lab: "Energy Lab" },
        { lab: "Energy Lab" },
        { item: " ", lab: "Energy Lab" },
        { item: "Amprex Blueprint", lab: "Energy Lab" },
      ],
    });
    const partial = await freshDropData();
    partial.loadFromDisk();
    expect(partial.searchDrops("dojo", "place").rows).toEqual([
      {
        item: "Amprex Blueprint",
        place: "Energy Lab",
        rarity: "Common",
        chance: 100,
        kind: "dojo",
      },
    ]);
  });
});

describe("dojoResearchEntries", () => {
  const MODULE = `
local Data = {
["Labs"] = {
\t["Corpus"] = {
\t\tName = "Energy Lab",
\t\tFaction = "Corpus"},
\t["Bash"] = {
\t\tName = "Ventkids' Bash Lab",
\t\tFaction = "Ventkids"},
\t["Hollow"] = {
\t\tName = "Dagath's Hollow",
\t\tFaction = "Tenno"},
\t},
["Research"] = {
\t-- Energy Lab --
\t["Amprex"] = {
\t\tImage = 'Amprex.png',
\t\tLab = 'Corpus',
\t\tResources = {{Name = 'Fieldron', Count = 5},
\t\t\t\t\t{Name = 'Rubedo', Count = 900}},
\t\tCredits = 15000},
\t['Squad Energy Restore (Medium)'] = {
\t\tLab = 'Corpus'},
\t["Squad Energy Restore (Medium) x 10"] = {
\t\tLab = 'Corpus'},
\t['Squad Energy Restore (Large) x 100'] = {
\t\tLab = 'Corpus'},
\t['Ostron Relaxed (Seated)'] = {
\t\tLab = 'Bash'},
\t['Solaris Hazard Worker(Standing)'] = {
\t\tLab = 'Bash'},
\t['Ghoulsaw Grip'] = {
\t\tLab = 'Bash'},
\t-- ['Dagath'] = {
\t-- \tLab = 'Hollow'},
\t}
}
return Data`;

  const entries = dojoResearchEntries(MODULE) as Array<{ item: string; lab: string }>;

  it("names each research its blueprint and resolves the lab", () => {
    expect(entries).toContainEqual({ item: "Amprex Blueprint", lab: "Energy Lab" });
    expect(entries).toContainEqual({ item: "Ghoulsaw Grip Blueprint", lab: "Ventkids' Bash Lab" });
  });

  it("collapses a bundle suffix onto the single recipe", () => {
    expect(entries.filter((e) => e.item.includes("Squad Energy Restore"))).toEqual([
      { item: "Squad Energy Restore (Large) Blueprint", lab: "Energy Lab" },
      { item: "Squad Energy Restore (Medium) Blueprint", lab: "Energy Lab" },
    ]);
  });

  it("skips decoration poses and commented-out entries", () => {
    expect(entries.some((e) => /\((?:Standing|Seated)\)/.test(e.item))).toBe(false);
    expect(entries.some((e) => e.lab === "Dagath's Hollow")).toBe(false);
  });

  it("sorts by lab then item", () => {
    const sorted = [...entries].sort(
      (a, b) => a.lab.localeCompare(b.lab) || a.item.localeCompare(b.item),
    );
    expect(entries).toEqual(sorted);
  });
});
