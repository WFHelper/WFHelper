import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MissionRewardSummary } from "../../config/shared/missionRewardsTypes";

let tmpDir = "";

vi.mock("electron", () => ({ app: { getPath: () => tmpDir } }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  appendSummary,
  loadHistory,
  normalizeMissionRewardsQuery,
  queryHistory,
  recentSummaries,
  unloadHistory,
} from "../../services/missionRewardsHistory";

const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
const RELIC = "/Lotus/Types/Game/Projections/T1VoidProjectionTestBronze";

function summary(
  id: string,
  endedAt: number,
  items: MissionRewardSummary["items"],
  extra: Partial<MissionRewardSummary> = {},
): MissionRewardSummary {
  return {
    id,
    endedAt,
    readAt: endedAt + 20_000,
    missionCount: 1,
    items,
    credits: 1_000,
    endo: 0,
    ...extra,
  };
}

function file(name: string): string {
  return path.join(tmpDir, name);
}

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(file(name), "utf8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-history-"));
});

afterEach(() => {
  unloadHistory();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("stored history", () => {
  it("moves the legacy newest-first list into the compact file once", () => {
    const legacy = [
      summary("b", 2_000, [{ uniqueName: PLASTIDS, count: 5 }], { missionType: "MT_DEFENSE" }),
      summary("a", 1_000, [
        { uniqueName: PLASTIDS, count: 2 },
        { uniqueName: CELL, count: 1 },
      ]),
      { id: "broken", endedAt: "yesterday" },
    ];
    fs.writeFileSync(file("mission-rewards.json"), JSON.stringify(legacy));

    loadHistory();

    expect(recentSummaries(10).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(recentSummaries(10)[1].items).toEqual([
      { uniqueName: PLASTIDS, count: 2 },
      { uniqueName: CELL, count: 1 },
    ]);
    // Reading never writes; the migrated list lands with the next recorded mission.
    expect(fs.existsSync(file("mission-history.json"))).toBe(false);
    appendSummary(summary("c", 3_000, [{ uniqueName: RELIC, count: 1 }]));
    expect(readJson("mission-history.json")).toEqual({
      version: 2,
      names: [PLASTIDS, CELL, RELIC],
      missions: [
        expect.objectContaining({ id: "a", items: [0, 2, 1, 1] }),
        expect.objectContaining({ id: "b", items: [0, 5], missionType: "MT_DEFENSE" }),
        expect.objectContaining({ id: "c", items: [2, 1] }),
      ],
    });
    expect(readJson("mission-rewards.json")).toEqual(legacy);

    fs.writeFileSync(file("mission-rewards.json"), JSON.stringify([summary("d", 4_000, [])]));
    unloadHistory();
    loadHistory();
    expect(queryHistory({ offset: 0, limit: 1 }).recorded).toBe(3);
  });

  it("keeps every mission across a restart, not just the newest ten", () => {
    loadHistory();
    for (let i = 0; i < 25; i += 1) {
      appendSummary(summary(`m${i}`, i * 60_000, [{ uniqueName: RELIC, count: 1 }]));
    }
    unloadHistory();
    loadHistory();

    expect(queryHistory({ offset: 0, limit: 1 }).recorded).toBe(25);
    expect(recentSummaries(3).map((entry) => entry.id)).toEqual(["m24", "m23", "m22"]);
    expect((readJson("mission-history.json") as { names: string[] }).names).toEqual([RELIC]);
  });

  it("drops malformed missions and unknown name indexes but keeps the rest", () => {
    fs.writeFileSync(
      file("mission-history.json"),
      JSON.stringify({
        version: 2,
        names: [PLASTIDS, "not a path", CELL],
        missions: [
          { ...summary("ok", 1_000, []), items: [2, 3] },
          { ...summary("bad-name", 2_000, []), items: [1, 3] },
          { ...summary("out-of-range", 3_000, []), items: [7, 1] },
          { ...summary("odd", 4_000, []), items: [0] },
          {
            ...summary("type", 5_000, []),
            missionType: "not a type",
            node: "SolNode25",
            items: [],
          },
          { ...summary("dup", 6_000, []), items: [] },
          { ...summary("dup", 7_000, []), items: [0, 1] },
        ],
      }),
    );

    loadHistory();

    const entries = recentSummaries(10);
    expect(entries.map((entry) => entry.id)).toEqual(["dup", "type", "ok"]);
    expect(entries[0].items).toEqual([]);
    expect(entries[1]).not.toHaveProperty("missionType");
    expect(entries[1].node).toBe("SolNode25");
    expect(entries[2].items).toEqual([{ uniqueName: CELL, count: 3 }]);
  });

  it("starts empty from a file that is not a history", () => {
    fs.writeFileSync(file("mission-history.json"), "{ not json");
    loadHistory();
    expect(queryHistory({ offset: 0, limit: 1 }).recorded).toBe(0);
  });
});

describe("queries", () => {
  const DAY = 86_400_000;

  beforeEach(() => {
    loadHistory();
    appendSummary(
      summary("old-defense", 1 * DAY, [{ uniqueName: CELL, count: 2 }], {
        missionType: "MT_DEFENSE",
        credits: 100,
      }),
    );
    appendSummary(
      summary("survival", 5 * DAY, [{ uniqueName: PLASTIDS, count: 30 }], {
        missionType: "MT_SURVIVAL",
        missionCount: 2,
        credits: 200,
        endo: 50,
      }),
    );
    appendSummary(
      summary(
        "new-defense",
        9 * DAY,
        [
          { uniqueName: PLASTIDS, count: 10 },
          { uniqueName: RELIC, count: 1 },
        ],
        { missionType: "MT_DEFENSE", credits: 300 },
      ),
    );
  });

  it("totals every match and pages newest first", () => {
    const first = queryHistory({ offset: 0, limit: 2 });
    expect(first.summaries.map((entry) => entry.id)).toEqual(["new-defense", "survival"]);
    expect(first.matched).toBe(3);
    expect(first.totals).toEqual({
      missions: 4,
      credits: 600,
      endo: 50,
      items: [
        { uniqueName: PLASTIDS, count: 40 },
        { uniqueName: CELL, count: 2 },
        { uniqueName: RELIC, count: 1 },
      ],
    });
    expect(first.recorded).toBe(3);
    expect(first.missionTypes).toEqual(["MT_DEFENSE", "MT_SURVIVAL"]);
    expect(first.itemTypes.sort()).toEqual([CELL, PLASTIDS, RELIC].sort());

    const second = queryHistory({ offset: 2, limit: 2 });
    expect(second.summaries.map((entry) => entry.id)).toEqual(["old-defense"]);
  });

  it("filters by start, mission type and received items, leaving the latest alone", () => {
    const recent = queryHistory({ offset: 0, limit: 10, since: 4 * DAY });
    expect(recent.summaries.map((entry) => entry.id)).toEqual(["new-defense", "survival"]);

    const defense = queryHistory({ offset: 0, limit: 10, missionType: "MT_DEFENSE" });
    expect(defense.summaries.map((entry) => entry.id)).toEqual(["new-defense", "old-defense"]);
    expect(defense.totals.credits).toBe(400);

    const plastids = queryHistory({ offset: 0, limit: 10, uniqueNames: [PLASTIDS, "/Unknown"] });
    expect(plastids.summaries.map((entry) => entry.id)).toEqual(["new-defense", "survival"]);

    const none = queryHistory({ offset: 0, limit: 10, uniqueNames: [] });
    expect(none.matched).toBe(0);
    expect(none.latest?.id).toBe("new-defense");
  });
});

describe("normalizeMissionRewardsQuery", () => {
  it("bounds renderer input and drops what it cannot use", () => {
    expect(normalizeMissionRewardsQuery(null)).toBeNull();
    expect(normalizeMissionRewardsQuery({ offset: -1, limit: 10 })).toBeNull();
    expect(normalizeMissionRewardsQuery({ offset: 0, limit: 0 })).toBeNull();
    expect(normalizeMissionRewardsQuery({ offset: 1.5, limit: 10 })).toBeNull();
    expect(
      normalizeMissionRewardsQuery({
        offset: 5,
        limit: 10_000,
        since: "today",
        missionType: "MT_DEFENSE; DROP",
        uniqueNames: [PLASTIDS, 3, "relative/path", "/".padEnd(300, "x")],
      }),
    ).toEqual({ offset: 5, limit: 200, uniqueNames: [PLASTIDS] });
    expect(
      normalizeMissionRewardsQuery({ offset: 0, limit: 5, since: 10, missionType: "MT_SURVIVAL" }),
    ).toEqual({ offset: 0, limit: 5, since: 10, missionType: "MT_SURVIVAL" });
  });
});
