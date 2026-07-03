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

  it("returns null for empty input", () => {
    expect(parser.parseRaw(null)).toBeNull();
  });
});
