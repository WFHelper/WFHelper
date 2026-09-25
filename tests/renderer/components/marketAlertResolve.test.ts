import { describe, expect, it } from "vitest";

import { criteriaChips } from "../../../src/components/market/alerts/alertResolve.js";
import type {
  MarketAlertRule,
  MarketAlertSellerStatus,
  RivenAlertMatch,
} from "../../../config/shared/marketAlertTypes.js";

function rivenRule(extra: Partial<RivenAlertMatch> = {}): MarketAlertRule {
  return {
    id: "riven-rule",
    name: "Boar",
    kind: "riven",
    enabled: true,
    cooldownMinutes: 60,
    noCooldown: false,
    riven: {
      weaponUrlName: "boar",
      requirePositive: [],
      excludeAttributes: [],
      statBounds: [],
      ...extra,
    },
  };
}

function itemRule(statuses: MarketAlertSellerStatus[]): MarketAlertRule {
  return {
    id: "item-rule",
    name: "Energize",
    kind: "item",
    enabled: true,
    cooldownMinutes: 60,
    noCooldown: false,
    item: { itemUrlName: "arcane_energize", side: "sell", statuses, maxPlatinum: 50 },
  };
}

const statusChips = (rule: MarketAlertRule) =>
  criteriaChips(rule)
    .filter((chip) => chip.id.startsWith("status-"))
    .map(({ id, titleKey, labelKey }) => ({ id, titleKey, labelKey }));

const BOTH = [
  { id: "status-ingame", titleKey: "marketAlerts.sellerStatus", labelKey: "common.inGame" },
  { id: "status-online", titleKey: "marketAlerts.sellerStatus", labelKey: "common.online" },
];

describe("criteriaChips seller status", () => {
  it("gives riven and item rules the same chip per status", () => {
    expect(statusChips(rivenRule({ statuses: ["ingame", "online"] }))).toEqual(BOTH);
    expect(statusChips(itemRule(["ingame", "online"]))).toEqual(BOTH);
    expect(statusChips(rivenRule({ statuses: ["online"] }))).toEqual([BOTH[1]]);
  });

  it("shows no status chip for an any seller rule", () => {
    expect(statusChips(rivenRule())).toEqual([]);
    expect(statusChips(rivenRule({ statuses: [] }))).toEqual([]);
    expect(statusChips(itemRule([]))).toEqual([]);
  });
});
