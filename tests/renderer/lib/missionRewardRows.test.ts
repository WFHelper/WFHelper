import { describe, expect, it } from "vitest";

import { normalizeMarketName } from "../../../src/lib/marketNaming.js";
import {
  buildRewardRows,
  matchRewardItemTypes,
  mergeFirstPage,
  missionPeriodStart,
  missionTypeLabel,
  readFailureDetailKey,
  rewardRowTotals,
  type RewardRowSources,
} from "../../../src/lib/missionRewardRows.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const PRIME_PART = "/Lotus/Types/Recipes/WarframeRecipes/EmberPrimeChassisComponent";
const UNKNOWN = "/Lotus/Types/Items/MiscItems/SomeNewResource";

const DB: Record<string, ItemDbEntry> = {
  [FORMA_BP]: {
    name: "Forma Blueprint",
    displayName: "Forma-Blaupause",
    imageUrl: null,
    tradable: true,
  },
  [PLASTIDS]: { name: "Plastids", imageUrl: "https://assets/plastids.png" },
  [PRIME_PART]: {
    name: "Ember Prime Chassis",
    imageUrl: null,
    tradable: true,
    ducats: 45,
    vaulted: true,
  },
};

function sources(prices: Record<string, number>): RewardRowSources {
  return {
    db: DB,
    lookup: {
      [normalizeMarketName(FORMA_BP)]: { url_name: "forma_blueprint", gameRef: FORMA_BP },
      [normalizeMarketName(PRIME_PART)]: { url_name: "ember_prime_chassis", gameRef: PRIME_PART },
    },
    relics: null,
    priceOf: (key) => prices[key] ?? null,
  };
}

describe("mission reward rows", () => {
  it("prices unranked rewards, sorts by value and counts what has no price", () => {
    const rows = buildRewardRows(
      [
        { uniqueName: PLASTIDS, count: 200 },
        { uniqueName: FORMA_BP, count: 2 },
        { uniqueName: PRIME_PART, count: 1 },
        { uniqueName: UNKNOWN, count: 3 },
      ],
      sources({ "forma_blueprint:rank-v3:r0": 6 }),
    );

    expect(rows.map((row) => row.uniqueName)).toEqual([FORMA_BP, PRIME_PART, PLASTIDS, UNKNOWN]);
    expect(rows[0]).toMatchObject({ name: "Forma-Blaupause", platinum: 12, openable: true });
    expect(rows[1]).toMatchObject({ platinum: null, ducats: 45, vaulted: true, unpriced: true });
    expect(rows[3]).toMatchObject({ openable: false, platinum: null, unpriced: false });
    expect(rewardRowTotals(rows)).toEqual({ platinum: 12, ducats: 45, unpriced: 1 });
  });

  it("falls back to the bare slug price when no rank-0 price is cached", () => {
    const [row] = buildRewardRows(
      [{ uniqueName: FORMA_BP, count: 1 }],
      sources({ forma_blueprint: 5 }),
    );
    expect(row?.platinum).toBe(5);
  });

  it("searches shown, English and fallback names of recorded items only", () => {
    const recorded = [FORMA_BP, PLASTIDS, UNKNOWN];
    expect(matchRewardItemTypes(recorded, "blaupause", DB)).toEqual([FORMA_BP]);
    expect(matchRewardItemTypes(recorded, "FORMA", DB)).toEqual([FORMA_BP]);
    expect(matchRewardItemTypes(recorded, "new resource", DB)).toEqual([UNKNOWN]);
    expect(matchRewardItemTypes(recorded, "chassis", DB)).toEqual([]);
    expect(matchRewardItemTypes(recorded, "   ", DB)).toEqual([]);
  });

  it("labels mission types, including ones without a known name", () => {
    expect(missionTypeLabel("MT_SURVIVAL")).toBe("Survival");
    expect(missionTypeLabel("MT_BRAND_NEW")).toBe("Brand New");
    expect(missionTypeLabel(undefined)).toBeNull();
  });

  it("explains a failed read only for causes that have a detail sentence", () => {
    expect(readFailureDetailKey("access-denied")).toBe("titlebar.tooltip.accessDenied");
    expect(readFailureDetailKey("no-fresh-copy")).toBe("dashboard.lastMission.noFreshCopy");
    expect(readFailureDetailKey("error")).toBeNull();
    expect(readFailureDetailKey(undefined)).toBeNull();
  });

  it("starts a period at local midnight, a rolling window or never", () => {
    const now = new Date(2026, 8, 20, 15, 30).getTime();
    expect(missionPeriodStart("today", now)).toBe(new Date(2026, 8, 20).getTime());
    expect(missionPeriodStart("7d", now)).toBe(now - 7 * 86_400_000);
    expect(missionPeriodStart("30d", now)).toBe(now - 30 * 86_400_000);
    expect(missionPeriodStart("all", now)).toBeNull();
  });

  it("keeps every loaded row when a refreshed first page arrives", () => {
    const rows = (ids: string[]) => ids.map((id) => ({ id }));
    const loaded = rows(Array.from({ length: 250 }, (_, i) => `m${250 - i}`));
    const first = rows(["m252", "m251", ...Array.from({ length: 48 }, (_, i) => `m${250 - i}`)]);

    const merged = mergeFirstPage(loaded, first, 252);
    expect(merged).toHaveLength(252);
    expect(merged.slice(0, 3).map((row) => row.id)).toEqual(["m252", "m251", "m250"]);
    expect(merged[merged.length - 1]?.id).toBe("m1");
    expect(new Set(merged.map((row) => row.id)).size).toBe(252);
  });

  it("starts over when the fresh page no longer meets the loaded rows", () => {
    const loaded = [{ id: "a" }, { id: "b" }];
    expect(mergeFirstPage(loaded, [{ id: "x" }, { id: "y" }], 10)).toEqual([
      { id: "x" },
      { id: "y" },
    ]);
    expect(mergeFirstPage([], [{ id: "x" }], 1)).toEqual([{ id: "x" }]);
  });
});
