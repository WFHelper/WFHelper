import { describe, expect, it } from "vitest";

import type { MissionRewardsStatus } from "../../../config/shared/missionRewardsTypes.js";
import { normalizeMarketName } from "../../../src/lib/marketNaming.js";
import {
  appendPage,
  buildRewardRows,
  createPageLoader,
  matchRewardItemTypes,
  mergeFirstPage,
  missionPeriodStart,
  missionStatusText,
  missionTypeLabel,
  rewardRowTotals,
  type PageLoadMode,
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

  it("says a new read is in progress even after a failed one, and explains a failure", () => {
    const text = (status: Partial<MissionRewardsStatus> | null) =>
      missionStatusText(status && { phase: "idle", pendingMissions: 0, ...status }, (key) => key);
    expect(text({ phase: "reading", lastFailure: "no-fresh-copy" })).toBe(
      "dashboard.lastMission.reading",
    );
    expect(text({ blocked: "tracking-off", phase: "waiting" })).toBe(
      "dashboard.lastMission.trackingOff",
    );
    expect(text({ lastFailure: "access-denied" })).toBe(
      "dashboard.lastMission.readFailed titlebar.tooltip.accessDenied",
    );
    expect(text({ lastFailure: "error" })).toBe("dashboard.lastMission.readFailed");
    expect(text({})).toBeNull();
    expect(text(null)).toBeNull();
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

  it("appends a later page without the rows a newly recorded mission pushed into it", () => {
    const rows = (ids: string[]) => ids.map((id) => ({ id }));
    expect(appendPage(rows(["m3", "m2"]), rows(["m2", "m1"]))).toEqual(rows(["m3", "m2", "m1"]));
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

interface Row {
  id: string;
  missionType: string;
}

interface RowPage {
  summaries: Row[];
  matched: number;
}

function missionRows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    missionType: "MT_SURVIVAL",
  }));
}

function pageOf(rows: Row[], offset = 0, size = 50): RowPage {
  return { summaries: rows.slice(offset, offset + size), matched: rows.length };
}

/** The view's rows and page, with every query held until the test answers it. */
function pageList() {
  const view = {
    rows: [] as Row[],
    page: null as RowPage | null,
    failed: false,
    failedFilterChange: false,
  };
  const load = createPageLoader<Row, RowPage>({
    rows: () => view.rows,
    show: (rows, page) => {
      view.rows = rows;
      if (page) view.page = page;
      view.failed = false;
      view.failedFilterChange = false;
    },
    fail: (_error, rowsOutdated) => {
      view.failed = true;
      if (rowsOutdated) view.failedFilterChange = true;
    },
  });
  function request(mode: PageLoadMode) {
    let answer: (page: RowPage | null) => void = () => {};
    let refuse: (error: Error) => void = () => {};
    const query = new Promise<RowPage | null>((resolve, reject) => {
      answer = resolve;
      refuse = reject;
    });
    const done = load(mode, () => query);
    return {
      resolve: async (page: RowPage | null) => {
        answer(page);
        await done;
      },
      reject: async () => {
        refuse(new Error("query failed"));
        await done;
      },
    };
  }
  return { view, request };
}

describe("mission page loader", () => {
  // Two pages of every mission type are loaded, then the type filter narrows to survival.
  const ALL = missionRows("m", 60).map((row, i) =>
    i === 50 ? { ...row, missionType: "MT_DEFENSE" } : row,
  );
  const SURVIVAL = ALL.filter((row) => row.missionType === "MT_SURVIVAL");

  async function loadAll(): Promise<ReturnType<typeof pageList>> {
    const list = pageList();
    await list.request("replace").resolve(pageOf(ALL));
    await list.request("append").resolve(pageOf(ALL, 50));
    expect(list.view.rows).toEqual(ALL);
    return list;
  }

  it.each(["replacement", "refresh"])(
    "keeps only the new filter's rows when a refresh overlaps a filter change, %s answered first",
    async (earlier) => {
      const list = await loadAll();
      const replacement = list.request("replace");
      const refresh = list.request("merge");
      const [first, second] =
        earlier === "replacement" ? [replacement, refresh] : [refresh, replacement];
      await first.resolve(pageOf(SURVIVAL));
      await second.resolve(pageOf(SURVIVAL));
      expect(list.view.rows).toEqual(SURVIVAL.slice(0, 50));
      expect(list.view.page?.matched).toBe(59);

      await list.request("append").resolve(pageOf(SURVIVAL, 50));
      expect(list.view.rows).toEqual(SURVIVAL);
    },
  );

  it("recovers from a rejected filter change and ignores an earlier filter's late answer", async () => {
    const list = await loadAll();
    const superseded = list.request("replace");
    const replacement = list.request("replace");
    const refresh = list.request("merge");
    await replacement.reject();
    await refresh.resolve(pageOf(SURVIVAL));
    await superseded.resolve(pageOf(ALL));
    expect(list.view.rows).toEqual(SURVIVAL.slice(0, 50));
    expect(list.view.failed).toBe(false);

    await list.request("merge").reject();
    expect(list.view.failed).toBe(true);
    expect(list.view.rows).toEqual(SURVIVAL.slice(0, 50));
  });

  it("shows a rejected filter change as failed instead of the previous filter's rows", async () => {
    const list = await loadAll();
    await list.request("replace").reject();
    expect(list.view.failedFilterChange).toBe(true);

    await list.request("merge").reject();
    expect(list.view.failedFilterChange).toBe(true);

    await list.request("merge").resolve(pageOf(SURVIVAL));
    expect(list.view.rows).toEqual(SURVIVAL.slice(0, 50));
    expect(list.view).toMatchObject({ failed: false, failedFilterChange: false });

    await list.request("merge").reject();
    expect(list.view).toMatchObject({ failed: true, failedFilterChange: false });
  });

  it("drops a Load more sent before the new filter's first page arrived", async () => {
    // Pages of four: its offset counts the eight rows loaded under the previous filter.
    const previous = missionRows("p", 12);
    const next = missionRows("n", 10);
    const list = pageList();
    await list.request("replace").resolve(pageOf(previous, 0, 4));
    await list.request("append").resolve(pageOf(previous, 4, 4));
    const replacement = list.request("replace");
    const more = list.request("append");
    await replacement.resolve(pageOf(next, 0, 4));
    await more.resolve(pageOf(next, 8, 4));
    expect(list.view.rows).toEqual(next.slice(0, 4));

    await list.request("append").resolve(pageOf(next, 4, 4));
    expect(list.view.rows).toEqual(next.slice(0, 8));
  });
});
