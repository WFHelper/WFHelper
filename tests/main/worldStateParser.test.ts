import { describe, expect, it } from "vitest";

import { MISSION_TYPE_LABELS } from "../../config/shared/missionTypes";
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

interface ParsedDailies {
  sortie: {
    id: string;
    expiry: string | null;
    boss: string;
    missions: Array<{ node: string; mission: string; modifier: string }>;
  } | null;
  archonHunt: {
    id: string;
    boss: string;
    missions: Array<{ node: string; mission: string }>;
  } | null;
  descents: { activation: string | null; expiry: string | null } | null;
  calendarSeason: {
    activation: string | null;
    expiry: string | null;
    season: string;
    days?: Array<{
      day: number;
      events: Array<{
        kind: string;
        label: string;
        description?: string;
        uniqueName?: string;
      }>;
    }>;
  } | null;
  nightwave: {
    season: number;
    phase: number;
    affiliationTag: string;
    challenges: Array<{
      id: string;
      name: string;
      title: string;
      description: string;
      standing: number;
      requiredCount: number;
      isDaily: boolean;
      isElite: boolean;
    }>;
  } | null;
  alerts: Array<{
    id: string;
    node: string;
    mission: string;
    faction: string;
    minLevel: number;
    maxLevel: number;
    credits: number;
    items: Array<{ name: string; count: number }>;
  }>;
}
const parseDailies = (raw: Parameters<typeof parser.parseRaw>[0]) =>
  parser.parseRaw(raw) as unknown as ParsedDailies;

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

  it("labels fissures with DE's mission-type meanings", () => {
    const now = Date.now();
    const fissureFor = (missionType: string, node = "UnmappedNode") =>
      parseRaw({
        ActiveMissions: [
          {
            Modifier: "VoidT1",
            MissionType: missionType,
            Node: node,
            Expiry: dateLong(now + 1000),
          },
        ],
      }).fissures[0];

    expect(fissureFor("MT_TERRITORY").missionType).toBe("Interception");
    expect(fissureFor("MT_PURIFY").missionType).toBe("Infested Salvage");
    expect(fissureFor("MT_ARTIFACT").missionType).toBe("Disruption");
  });

  it("title-cases the all-caps mission names DE ships", () => {
    const now = Date.now();
    const parsed = parseRaw({
      ActiveMissions: [
        {
          Modifier: "VoidT2",
          MissionType: "MT_CORRUPTION",
          Node: "SolNode230",
          Expiry: dateLong(now + 1000),
        },
        // MT_RAILJACK has no name in DE's mission-type table, so the node's own
        // ALL CAPS mission name is the fallback that has to be title-cased.
        {
          Modifier: "VoidT2",
          MissionType: "MT_RAILJACK",
          Node: "CrewBattleNode524",
          Expiry: dateLong(now + 1000),
        },
      ],
    });

    expect(parsed.fissures.map((f) => f.missionType)).toEqual(["Void Flood", "Volatile"]);
  });

  it("keeps the fallback mission labels in step with DE's export", () => {
    const now = Date.now();
    for (const [missionType, label] of Object.entries(MISSION_TYPE_LABELS)) {
      const parsed = parseRaw({
        ActiveMissions: [
          {
            Modifier: "VoidT1",
            MissionType: missionType,
            Node: "UnmappedNode",
            Expiry: dateLong(now + 1000),
          },
        ],
      });
      expect(parsed.fissures[0].missionType).toBe(label);
    }
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

  it("resolves weapon deals to their in-game name, not the path slug", () => {
    const now = Date.now();
    const parsed = parser.parseRaw({
      DailyDeals: [
        {
          StoreItem: "/Lotus/StoreItems/Weapons/Tenno/Melee/Glaives/Boomerang/BoomerangWeapon",
          Expiry: dateLong(now + 3600_000),
        },
      ],
    }) as Record<string, unknown>;

    const deals = parsed.dailyDeals as Array<Record<string, unknown>>;
    // Was "Boomerang Weapon" before ExportWeapons joined the lookup.
    expect(deals[0].item).toBe("Kestrel");
  });

  it("returns null for empty input", () => {
    expect(parser.parseRaw(null)).toBeNull();
  });
});

describe("worldStateParser sortie, archon hunt, nightwave and alerts", () => {
  const now = Date.now();
  const window = { Activation: dateLong(now - 60_000), Expiry: dateLong(now + 3600_000) };

  it("resolves sortie variants to readable node, mission and modifier", () => {
    const parsed = parseDailies({
      Sorties: [
        {
          ...window,
          _id: { $oid: "sortie1" },
          Boss: "SORTIE_BOSS_LEPHANTIS",
          Variants: [
            {
              missionType: "MT_SURVIVAL",
              modifierType: "SORTIE_MODIFIER_ARMOR",
              node: "SolNode15",
            },
            {
              missionType: "MT_EXTERMINATION",
              modifierType: "SORTIE_MODIFIER_MELEE_ONLY",
              node: "SolNode11",
            },
            {
              missionType: "MT_DEFENSE",
              modifierType: "SORTIE_MODIFIER_MADE_UP",
              node: "SolNode63",
            },
          ],
        },
      ],
    });

    // The id joins the inventory's LastSortieReward for completion tracking.
    expect(parsed.sortie?.id).toBe("sortie1");
    expect(parsed.sortie?.boss).toBe("Lephantis");
    expect(parsed.sortie?.expiry).toBeTruthy();
    expect(parsed.sortie?.missions).toEqual([
      // The variant mission wins over the node's usual one (Pacific is Rescue).
      { node: "Pacific (Earth)", mission: "Survival", modifier: "Enhanced Enemy Armor" },
      { node: "Tharsis (Mars)", mission: "Exterminate", modifier: "Melee Only" },
      // An unmapped modifier degrades to readable text, not the raw enum.
      { node: "Mantle (Earth)", mission: "Defense", modifier: "Made Up" },
    ]);
  });

  it("parses the archon hunt and yields null without LiteSorties", () => {
    const parsed = parseDailies({
      LiteSorties: [
        {
          ...window,
          _id: { $oid: "lite1" },
          Boss: "SORTIE_BOSS_NIRA",
          Missions: [
            { missionType: "MT_RESCUE", node: "SolNode25" },
            { missionType: "MT_SURVIVAL", node: "SolNode15" },
          ],
        },
      ],
    });

    expect(parsed.archonHunt?.id).toBe("lite1");
    expect(parsed.archonHunt?.boss).toBe("Nira");
    expect(parsed.archonHunt?.missions).toEqual([
      { node: "Callisto (Jupiter)", mission: "Rescue" },
      { node: "Pacific (Earth)", mission: "Survival" },
    ]);
    expect(parseDailies({ ActiveMissions: [] }).archonHunt).toBeNull();
  });

  it("drops expired nightwave acts but keeps ones with no expiry", () => {
    const parsed = parseDailies({
      SeasonInfo: {
        ...window,
        Season: 18,
        Phase: 0,
        ActiveChallenges: [
          {
            _id: { $oid: "live1" },
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "expired1" },
            Activation: dateLong(now - 7200_000),
            Expiry: dateLong(now - 60_000),
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "undated1" },
            Activation: dateLong(now - 60_000),
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
        ],
      },
    });

    expect((parsed.nightwave?.challenges ?? []).map((act) => act.id)).toEqual([
      "live1",
      "undated1",
    ]);
  });

  it("carries the season affiliation tag for the standing join", () => {
    const parsed = parseDailies({
      SeasonInfo: {
        ...window,
        Season: 18,
        Phase: 0,
        AffiliationTag: "RadioLegionIntermission16Syndicate",
        ActiveChallenges: [],
      },
    });
    expect(parsed.nightwave?.affiliationTag).toBe("RadioLegionIntermission16Syndicate");
  });

  it("parses the descent and calendar season windows", () => {
    const parsed = parseDailies({
      Descents: [{ ...window }],
      KnownCalendarSeasons: [{ ...window, Season: "CST_SUMMER" }],
    });
    expect(parsed.descents?.expiry).not.toBeNull();
    expect(parsed.calendarSeason?.season).toBe("Summer");
    const empty = parseDailies({});
    expect(empty.descents).toBeNull();
    expect(empty.calendarSeason).toBeNull();
  });

  type RawCalendarDay = {
    day?: number;
    events?: Array<{ type?: string; challenge?: string; reward?: string; upgrade?: string }>;
  };
  const calendarDays = (days: RawCalendarDay[]) =>
    parseDailies({ KnownCalendarSeasons: [{ ...window, Season: "CST_WINTER", Days: days }] })
      .calendarSeason?.days ?? [];

  it("resolves calendar days to structured events", () => {
    const days = calendarDays([
      { day: 9, events: [] },
      {
        day: 13,
        events: [
          { type: "CET_REWARD", reward: "/Lotus/StoreItems/Types/Restoratives/Consumable" },
          {
            type: "CET_CHALLENGE",
            challenge: "/Lotus/Types/Challenges/Calendar1999/CalendarKillEnemiesEasy",
          },
        ],
      },
    ]);
    // The empty day drops; the filled one keeps one entry per event.
    expect(days).toHaveLength(1);
    expect(days[0]?.day).toBe(13);
    expect(days[0]?.events).toHaveLength(2);
    expect(days[0]?.events.map((event) => event.kind)).toEqual(["reward", "challenge"]);
    expect(days[0]?.events.every((event) => event.label.length > 0)).toBe(true);
  });

  it("gives a calendar challenge both its title and its objective", () => {
    const [day] = calendarDays([
      {
        day: 20,
        events: [
          {
            type: "CET_CHALLENGE",
            challenge: "/Lotus/Types/Challenges/Calendar1999/CalendarKillEnemiesEasy",
          },
        ],
      },
    ]);
    expect(day?.events[0]?.label).toBe("Even the Odds");
    // |COUNT| resolves from the export's requiredCount, as nightwave acts do.
    expect(day?.events[0]?.description).toBe("Kill 250 Enemies");
  });

  it("keeps the reward path and strips dict icon tags from its name", () => {
    const [day] = calendarDays([
      {
        day: 21,
        events: [
          {
            type: "CET_REWARD",
            reward: "/Lotus/StoreItems/Types/Gameplay/NarmerSorties/ArchonCrystalBoreal",
          },
        ],
      },
    ]);
    expect(day?.events[0]?.uniqueName).toBe(
      "/Lotus/Types/Gameplay/NarmerSorties/ArchonCrystalBoreal",
    );
    expect(day?.events[0]?.label).toBe("Azure Archon Shard");
  });

  it("title-cases a shouted reward name", () => {
    const [day] = calendarDays([
      {
        day: 22,
        events: [
          {
            type: "CET_REWARD",
            reward: "/Lotus/StoreItems/Types/Gameplay/NarmerSorties/ArchonCrystal",
          },
        ],
      },
    ]);
    expect(day?.events[0]?.label).toBe("Archon Shard");
  });

  it("prettifies a store item the exports do not carry", () => {
    const [day] = calendarDays([
      {
        day: 23,
        events: [
          {
            type: "CET_REWARD",
            reward: "/Lotus/StoreItems/Types/Boosters/ModDropChanceBooster3DayStoreItem",
          },
        ],
      },
    ]);
    expect(day?.events[0]?.label).toBe("Mod Drop Chance Booster 3 Day");
  });

  it("emits calendar perk choices as upgrade events", () => {
    const [day] = calendarDays([
      {
        day: 24,
        events: [
          { type: "CET_UPGRADE", upgrade: "/Lotus/Upgrades/Calendar/Armor" },
          { type: "CET_UPGRADE", upgrade: "/Lotus/Upgrades/Calendar/AbilityStrength" },
          { type: "CET_UNKNOWN" },
        ],
      },
    ]);
    // The unknown kind drops rather than rendering a blank row.
    expect(day?.events).toHaveLength(2);
    expect(day?.events.map((event) => event.kind)).toEqual(["upgrade", "upgrade"]);
    expect(day?.events.map((event) => event.label)).toEqual(["Armor", "Ability Strength"]);
  });

  it("resolves nightwave acts, flags elites and degrades unknown challenges", () => {
    const parsed = parseDailies({
      SeasonInfo: {
        ...window,
        Season: 18,
        Phase: 0,
        ActiveChallenges: [
          {
            _id: { $oid: "daily1" },
            Daily: true,
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "elite1" },
            ...window,
            Challenge:
              "/Lotus/Types/Challenges/Seasons/WeeklyHard/SeasonWeeklyHardRiseOfTheMachine",
          },
          {
            _id: { $oid: "unknown1" },
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyMadeUpAct",
          },
        ],
      },
    });

    expect(parsed.nightwave?.season).toBe(18);
    expect(parsed.nightwave?.phase).toBe(0);
    const [daily, elite, unknown] = parsed.nightwave?.challenges ?? [];
    expect(daily).toMatchObject({
      id: "daily1",
      // The path tail joins the inventory's ChallengeProgress records.
      name: "SeasonDailyAimGlide",
      title: "Glider",
      description: "Kill 15 Enemies while Aim Gliding",
      standing: 1000,
      requiredCount: 15,
      isDaily: true,
      isElite: false,
    });
    expect(elite).toMatchObject({
      title: "Rise of the Machine",
      standing: 7000,
      isDaily: false,
      isElite: true,
    });
    // No export entry: the slug carries the title and stands in for the description.
    expect(unknown).toMatchObject({
      title: "Season Daily Made Up Act",
      description: "Season Daily Made Up Act",
      standing: 0,
      requiredCount: 0,
    });
  });

  it("resolves alerts and drops expired ones", () => {
    const parsed = parseDailies({
      Alerts: [
        {
          _id: { $oid: "alert1" },
          ...window,
          MissionInfo: {
            location: "SolNode25",
            missionType: "MT_TERRITORY",
            faction: "FC_CORPUS",
            minEnemyLevel: 1,
            maxEnemyLevel: 2,
            missionReward: {
              credits: 50000,
              countedItems: [
                { ItemType: "/Lotus/Types/Items/MiscItems/WaterFightBucks", ItemCount: 175 },
              ],
              items: ["/Lotus/Types/Items/MiscItems/MadeUpThing"],
            },
          },
        },
        {
          _id: { $oid: "expired" },
          Expiry: dateLong(now - 1000),
          MissionInfo: { location: "SolNode15", missionType: "MT_RESCUE" },
        },
      ],
    });

    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts[0]).toMatchObject({
      id: "alert1",
      // MT_TERRITORY is Interception in DE's own table, not the legacy label.
      node: "Callisto (Jupiter)",
      mission: "Interception",
      faction: "Corpus",
      minLevel: 1,
      maxLevel: 2,
      credits: 50000,
      items: [
        { name: "Nakak Pearls", count: 175 },
        { name: "Made Up Thing", count: 1 },
      ],
    });
  });

  it("parses a payload carrying none of the four keys", () => {
    const parsed = parseDailies({ ActiveMissions: [] });
    expect(parsed.sortie).toBeNull();
    expect(parsed.archonHunt).toBeNull();
    expect(parsed.nightwave).toBeNull();
    expect(parsed.alerts).toEqual([]);
  });

  it("survives a payload where any of the four keys is not an array", () => {
    // DE has shipped scalars in array slots before; one bad field must not cost
    // the fissures, cycles and bounties parsed from the same payload.
    const parsed = parseDailies({
      ActiveMissions: [],
      Sorties: [{ ...window, Boss: "SORTIE_BOSS_LEPHANTIS", Variants: {} }],
      LiteSorties: [{ ...window, Boss: "SORTIE_BOSS_NIRA", Missions: "nope" }],
      SeasonInfo: { ...window, Season: 18, Phase: 0, ActiveChallenges: {} },
      Alerts: {},
    } as unknown as Parameters<typeof parseDailies>[0]);

    expect(parsed.sortie).toMatchObject({ boss: "Lephantis", missions: [] });
    expect(parsed.archonHunt).toMatchObject({ boss: "Nira", missions: [] });
    expect(parsed.nightwave).toMatchObject({ season: 18, challenges: [] });
    expect(parsed.alerts).toEqual([]);
  });

  it("keeps an alert whose reward arrays are malformed", () => {
    const parsed = parseDailies({
      Alerts: [
        {
          ...window,
          _id: { $oid: "alert-1" },
          MissionInfo: {
            location: "SolNode25",
            missionType: "MT_RESCUE",
            faction: "FC_CORPUS",
            missionReward: { credits: 5000, countedItems: {}, items: "nope" },
          },
        },
      ],
    } as unknown as Parameters<typeof parseDailies>[0]);

    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts?.[0]).toMatchObject({ credits: 5000, items: [] });
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
      [50, 55],
      [60, 65],
      [70, 75],
      [90, 95],
      [110, 115],
    ]);

    const [cavia] = cycle({ EntratiLabSyndicate: nodes(5) });
    expect(cavia.jobs.map((j) => j.enemyLevels)).toEqual([
      [55, 60],
      [65, 70],
      [75, 80],
      [95, 100],
      [115, 120],
    ]);

    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.syndicate).toBe("The Hex");
    expect(hex.jobs.map((j) => j.enemyLevels)).toEqual([
      [65, 70],
      [75, 80],
      [85, 90],
      [95, 100],
      [105, 110],
      [115, 120],
      [125, 130],
    ]);
  });

  it("carries tier index for reward-pool lookup plus single-stage standing", () => {
    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.jobs.map((j) => j.tierIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(hex.jobs.map((j) => j.standingStages)).toEqual([
      [1000],
      [2000],
      [3000],
      [4000],
      [5000],
      [6000],
      [7500],
    ]);
  });

  it("skips unknown syndicates and falls back to region levels past the tier table", () => {
    expect(cycle({ MadeUpSyndicate: nodes(1) })).toHaveLength(0);

    const [zariman] = cycle({ ZarimanSyndicate: nodes(6) });
    expect(zariman.jobs[5].enemyLevels).toEqual([0, 0]);
  });
});
