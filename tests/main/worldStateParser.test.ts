import { describe, expect, it } from "vitest";

import * as parser from "../../services/worldStateParser";

// parseRaw returns Record<string, unknown>; shape only what these tests read.
interface ParsedWorldState {
  fissures: Array<{ tier: string; missionType: string; isStorm?: boolean }>;
  voidTrader?: { location?: string };
  vaultTrader?: { location?: string };
  sortie?: { expiry?: string };
}
const parseRaw = (raw: Parameters<typeof parser.parseRaw>[0]) =>
  parser.parseRaw(raw) as unknown as ParsedWorldState;

function dateLong(ms: number) {
  return { $date: { $numberLong: `${ms}` } };
}

describe("worldStateParser.parseRaw", () => {
  it("parses fissures and traders from raw world state", () => {
    const now = Date.now();
    const raw = {
      ActiveMissions: [
        {
          Modifier: "VoidT4",
          MissionType: "MT_CAPTURE",
          Node: "Marduk",
          Expiry: dateLong(now + 60_000),
        },
      ],
      VoidTraders: {
        Activation: dateLong(now - 60_000),
        Expiry: dateLong(now + 3600_000),
        Node: "EarthHUB",
      },
      PrimeVaultTraders: {
        Activation: dateLong(now - 60_000),
        Expiry: dateLong(now + 7200_000),
        Node: "MarsHUB",
        Manifest: [{ ItemType: "/Lotus/StoreItems/Types/Items/TestItem" }],
      },
      Sorties: [
        {
          Expiry: dateLong(now + 600_000),
        },
      ],
      Descents: [],
    };

    const parsed = parseRaw(raw);

    expect(parsed.fissures).toHaveLength(1);
    expect(parsed.fissures[0].tier).toBe("Axi");
    expect(parsed.fissures[0].missionType).toBe("Capture");
    expect(parsed.voidTrader?.location).toBe("Larunda Relay (Earth)");
    expect(parsed.vaultTrader?.location).toBe("Strata Relay (Mars)");
    expect(parsed.sortie?.expiry).toBeTruthy();
  });

  it("derives the real mission type for railjack void storms", () => {
    const now = Date.now();
    const parsed = parseRaw({
      VoidStorms: [
        { Node: "CrewBattleNode515", ActiveMissionTier: "VoidT3", Expiry: dateLong(now + 60_000) },
      ],
    });

    const storm = parsed.fissures.find((f) => f.isStorm);
    expect(storm?.tier).toBe("Neo");
    // Resolves the node's railjack mission instead of a hardcoded label.
    expect(storm?.missionType).toBe("Survival");
  });

  it("parses daily deals and drops expired ones", () => {
    const now = Date.now();
    const parsed = parser.parseRaw({
      DailyDeals: [
        {
          StoreItem: "/Lotus/StoreItems/Types/Items/TestItem",
          Expiry: dateLong(now + 3600_000),
          Discount: 50,
          OriginalPrice: 150,
          SalePrice: 75,
          AmountTotal: 300,
          AmountSold: 97,
        },
        { StoreItem: "/Lotus/StoreItems/Types/Items/OldItem", Expiry: dateLong(now - 1000) },
      ],
    }) as Record<string, unknown>;

    const deals = parsed.dailyDeals as Array<Record<string, unknown>>;
    expect(deals).toHaveLength(1);
    expect(deals[0].uniqueName).toBe("/Lotus/Types/Items/TestItem");
    expect(deals[0].salePrice).toBe(75);
    expect(deals[0].discount).toBe(50);
    expect(deals[0].sold).toBe(97);
    expect(deals[0].expiry).toBeTruthy();
  });

  it("returns null for empty input", () => {
    expect(parser.parseRaw(null)).toBeNull();
  });
});

describe("worldStateParser.parseBountyCycleBounties", () => {
  interface SeedBounty {
    syndicate: string;
    jobs: Array<{ enemyLevels: [number, number]; tierIndex: number; standingStages: number[] }>;
  }

  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ node: `FakeNode${i}` }));
  const cycle = (bounties: Record<string, { node: string }[]>) =>
    parser.parseBountyCycleBounties({ bounties }) as SeedBounty[];

  it("assigns static per-tier enemy levels (oracle jobs carry none)", () => {
    const [zariman] = cycle({ ZarimanSyndicate: nodes(5) });
    expect(zariman.jobs.map((j) => j.enemyLevels)).toEqual([
      [50, 55], [60, 65], [70, 75], [90, 95], [110, 115],
    ]);

    const [cavia] = cycle({ EntratiLabSyndicate: nodes(5) });
    expect(cavia.jobs.map((j) => j.enemyLevels)).toEqual([
      [55, 60], [65, 70], [75, 80], [95, 100], [115, 120],
    ]);

    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.syndicate).toBe("The Hex");
    expect(hex.jobs.map((j) => j.enemyLevels)).toEqual([
      [65, 70], [75, 80], [85, 90], [95, 100], [105, 110], [115, 120], [125, 130],
    ]);
  });

  it("carries tier index for reward-pool lookup plus single-stage standing", () => {
    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.jobs.map((j) => j.tierIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(hex.jobs.map((j) => j.standingStages)).toEqual([
      [1000], [2000], [3000], [4000], [5000], [6000], [7500],
    ]);
  });

  it("skips unknown syndicates and falls back to region levels past the tier table", () => {
    expect(cycle({ MadeUpSyndicate: nodes(1) })).toHaveLength(0);

    const [zariman] = cycle({ ZarimanSyndicate: nodes(6) });
    expect(zariman.jobs[5].enemyLevels).toEqual([0, 0]);
  });
});
