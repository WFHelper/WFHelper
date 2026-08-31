import { describe, expect, it } from "vitest";
import { ExportResources } from "warframe-public-export-plus";

import {
  archonShardDisplaySlots,
  archonShardIconUrl,
  archonShardUniqueName,
  archonShardUpgradeLabel,
  parseArchonShards,
  shardKindKey,
  summarizeArchonShards,
  ARCHON_SHARD_SLOT_COUNT,
  type ArchonShardColor,
} from "../../../src/lib/inventory/archonShards.js";
import type { ItemDbEntry, RawInventoryData } from "../../../src/types/inventory.js";

const MAG = "/Lotus/Powersuits/Mag/Mag";
const SARYN = "/Lotus/Powersuits/Saryn/Saryn";
const UPGRADE = "/Lotus/Upgrades/Invigorations/ArchonCrystalUpgrades/ArchonCrystalUpgrade";
const LOOSE = "/Lotus/Types/Gameplay/NarmerSorties/ArchonCrystal";

function inv(overrides: Record<string, unknown>): RawInventoryData {
  return overrides as RawInventoryData;
}

/** DE addresses sockets by index and pads skipped ones with `{}`. */
const FIXTURE = inv({
  Suits: [
    {
      ItemType: MAG,
      ItemId: { $oid: "mag-1" },
      ArchonCrystalUpgrades: [
        { UpgradeType: `${UPGRADE}WarframeAbilityStrength`, Color: "ACC_RED" },
        {},
        { UpgradeType: `${UPGRADE}WarframeHealthMaxMythic`, Color: "ACC_BLUE_MYTHIC" },
      ],
    },
    {
      ItemType: MAG,
      ItemId: { $oid: "mag-2" },
      ArchonCrystalUpgrades: [
        { UpgradeType: `${UPGRADE}WarframeAbilityStrength`, Color: "ACC_RED" },
      ],
    },
    {
      ItemType: SARYN,
      ItemId: { $oid: "saryn-1" },
      ArchonCrystalUpgrades: [
        { UpgradeType: `${UPGRADE}WarframeToxinDamage`, Color: "ACC_GREEN" },
        { UpgradeType: `${UPGRADE}WarframeCastingSpeed`, Color: "ACC_YELLOW" },
      ],
    },
    // No sockets at all, and an all-empty rack: neither is a shard holder.
    { ItemType: "/Lotus/Powersuits/Ash/Ash", ItemId: { $oid: "ash-1" } },
    {
      ItemType: "/Lotus/Powersuits/Nyx/Nyx",
      ItemId: { $oid: "nyx-1" },
      ArchonCrystalUpgrades: [{}, {}],
    },
  ],
  MiscItems: [
    { ItemType: `${LOOSE}Amar`, ItemCount: 3 },
    { ItemType: `${LOOSE}BorealMythic`, ItemCount: 1 },
    { ItemType: "/Lotus/Types/Items/MiscItems/Circuits", ItemCount: 900 },
  ],
});

describe("parseArchonShards", () => {
  it("returns nothing for a missing payload", () => {
    const data = parseArchonShards(null);
    expect(data.suits).toEqual([]);
    expect(data.bySuitType.size).toBe(0);
    expect(data.loose.size).toBe(0);
  });

  it("keeps every copy of one frame separate, keyed by instance", () => {
    const copies = parseArchonShards(FIXTURE).bySuitType.get(MAG);
    expect(copies?.map((copy) => copy.instanceId)).toEqual(["mag-1", "mag-2"]);
    expect(copies?.map((copy) => copy.filled)).toEqual([2, 1]);
  });

  it("reads colour, tauforged and empty sockets in payload order", () => {
    const mag = parseArchonShards(FIXTURE).bySuitType.get(MAG)?.[0];
    expect(mag?.slots).toEqual([
      {
        index: 0,
        color: "crimson",
        tauforged: false,
        filled: true,
        upgradeType: `${UPGRADE}WarframeAbilityStrength`,
      },
      { index: 1, color: null, tauforged: false, filled: false, upgradeType: null },
      {
        index: 2,
        color: "azure",
        tauforged: true,
        filled: true,
        upgradeType: `${UPGRADE}WarframeHealthMaxMythic`,
      },
    ]);
  });

  it("skips frames with no sockets and racks that are entirely empty", () => {
    const types = [...parseArchonShards(FIXTURE).bySuitType.keys()];
    expect(types).toEqual([MAG, SARYN]);
  });

  it("counts loose shards from MiscItems and ignores everything else", () => {
    const loose = parseArchonShards(FIXTURE).loose;
    expect(loose.get(shardKindKey("crimson", false))).toBe(3);
    expect(loose.get(shardKindKey("azure", true))).toBe(1);
    expect(loose.size).toBe(2);
  });

  it("treats a filled socket with no recognised colour as filled but colourless", () => {
    const data = parseArchonShards(
      inv({
        Suits: [{ ItemType: MAG, ArchonCrystalUpgrades: [{ UpgradeType: `${UPGRADE}Future` }] }],
      }),
    );
    expect(data.suits[0].slots[0]).toEqual({
      index: 0,
      color: null,
      tauforged: false,
      filled: true,
      upgradeType: `${UPGRADE}Future`,
    });
  });

  it("falls back to the Mythic upgrade suffix when Color is missing", () => {
    const data = parseArchonShards(
      inv({
        Suits: [
          { ItemType: MAG, ArchonCrystalUpgrades: [{ UpgradeType: `${UPGRADE}FutureMythic` }] },
        ],
      }),
    );
    expect(data.suits[0].slots[0].tauforged).toBe(true);
  });
});

describe("summarizeArchonShards", () => {
  const summary = summarizeArchonShards(parseArchonShards(FIXTURE));

  it("totals installed and unsocketed shards", () => {
    expect(summary.installed).toBe(5);
    expect(summary.unsocketed).toBe(4);
    expect(summary.unknownInstalled).toBe(0);
    expect(summary.suitsWithShards).toBe(3);
  });

  it("splits tauforged from plain shards of the same colour", () => {
    const rows = summary.stock.map((row) => [row.color, row.tauforged, row.total]);
    expect(rows).toEqual([
      ["crimson", false, 5],
      ["amber", false, 1],
      ["azure", true, 2],
      ["emerald", false, 1],
    ]);
  });

  it("names which frames hold each colour, most-loaded first", () => {
    const crimson = summary.stock.find((row) => row.color === "crimson" && !row.tauforged);
    expect(crimson?.installed).toBe(2);
    expect(crimson?.unsocketed).toBe(3);
    expect(crimson?.holders).toEqual([
      { itemType: MAG, instanceId: "mag-1", count: 1 },
      { itemType: MAG, instanceId: "mag-2", count: 1 },
    ]);
  });

  it("groups repeats of one colour on a single frame into one holder row", () => {
    const doubled = summarizeArchonShards(
      parseArchonShards(
        inv({
          Suits: [
            {
              ItemType: SARYN,
              ItemId: { $oid: "saryn-1" },
              ArchonCrystalUpgrades: [
                { UpgradeType: `${UPGRADE}A`, Color: "ACC_RED" },
                { UpgradeType: `${UPGRADE}B`, Color: "ACC_RED" },
              ],
            },
          ],
        }),
      ),
    );
    expect(doubled.stock[0].holders).toEqual([
      { itemType: SARYN, instanceId: "saryn-1", count: 2 },
    ]);
  });

  it("counts a colourless filled socket without inventing a colour row", () => {
    const unknown = summarizeArchonShards(
      parseArchonShards(
        inv({
          Suits: [{ ItemType: MAG, ArchonCrystalUpgrades: [{ UpgradeType: `${UPGRADE}X` }] }],
        }),
      ),
    );
    expect(unknown.installed).toBe(1);
    expect(unknown.unknownInstalled).toBe(1);
    expect(unknown.stock).toEqual([]);
  });

  it("reports loose shards with no frame holding them", () => {
    const looseOnly = summarizeArchonShards(
      parseArchonShards(inv({ MiscItems: [{ ItemType: `${LOOSE}Violet`, ItemCount: 2 }] })),
    );
    expect(looseOnly.stock).toEqual([
      {
        color: "violet",
        tauforged: false,
        installed: 0,
        unsocketed: 2,
        total: 2,
        holders: [],
      },
    ]);
  });
});

describe("display helpers", () => {
  it("pads a short rack out to the full socket count", () => {
    const mag = parseArchonShards(FIXTURE).bySuitType.get(MAG)?.[0];
    const slots = archonShardDisplaySlots(mag?.slots ?? []);
    expect(slots).toHaveLength(ARCHON_SHARD_SLOT_COUNT);
    expect(slots.slice(3).every((slot) => !slot.filled)).toBe(true);
    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never truncates a rack longer than the assumed socket count", () => {
    const slots = archonShardDisplaySlots(
      Array.from({ length: 6 }, (_, index) => ({
        index,
        color: null,
        tauforged: false,
        filled: false,
        upgradeType: null,
      })),
    );
    expect(slots).toHaveLength(6);
  });

  it("derives a readable English effect name from the upgrade uniqueName", () => {
    expect(archonShardUpgradeLabel(`${UPGRADE}WarframeAbilityStrength`)).toBe("Ability Strength");
    expect(archonShardUpgradeLabel(`${UPGRADE}MeleeCritDamageMythic`)).toBe("Melee Crit Damage");
    expect(archonShardUpgradeLabel(`${UPGRADE}WarframeHPBoostFromImpact`)).toBe(
      "HP Boost From Impact",
    );
    expect(archonShardUpgradeLabel(null)).toBe("");
  });
});

describe("shard icon lookup", () => {
  const EXPECTED: Readonly<Record<ArchonShardColor, string>> = {
    crimson: `${LOOSE}Amar`,
    amber: `${LOOSE}Nira`,
    azure: `${LOOSE}Boreal`,
    emerald: `${LOOSE}Green`,
    topaz: `${LOOSE}Orange`,
    violet: `${LOOSE}Violet`,
  };
  const COLORS = Object.keys(EXPECTED) as ArchonShardColor[];

  function db(entries: Record<string, ItemDbEntry>): Record<string, ItemDbEntry> {
    return entries;
  }

  it("maps every colour to its Archon crystal, Mythic for tauforged", () => {
    for (const color of COLORS) {
      expect(archonShardUniqueName(color, false)).toBe(EXPECTED[color]);
      expect(archonShardUniqueName(color, true)).toBe(`${EXPECTED[color]}Mythic`);
    }
  });

  // The mapping is only useful while DE still ships these uniqueNames with art.
  it("resolves against PublicExport, so a DE rename fails here", () => {
    for (const color of COLORS) {
      for (const uniqueName of [EXPECTED[color], `${EXPECTED[color]}Mythic`]) {
        expect(ExportResources[uniqueName]?.icon, uniqueName).toBeTruthy();
      }
    }
  });

  it("returns the item database image for a known shard", () => {
    const lookup = db({ [`${LOOSE}AmarMythic`]: { imageUrl: "https://cdn/amar-tau.png" } });
    expect(archonShardIconUrl(lookup, "crimson", true)).toBe("https://cdn/amar-tau.png");
  });

  it("falls back to null instead of a broken image", () => {
    expect(archonShardIconUrl({}, "crimson", false)).toBeNull();
    expect(
      archonShardIconUrl(db({ [`${LOOSE}Nira`]: { imageUrl: null } }), "amber", false),
    ).toBeNull();
    expect(archonShardIconUrl({}, null, false)).toBeNull();
  });
});
