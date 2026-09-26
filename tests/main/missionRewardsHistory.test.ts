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

  it("drops the oldest mission past the cap and the names only it used", () => {
    const MAX_MISSIONS = 10_000;
    fs.writeFileSync(
      file("mission-history.json"),
      JSON.stringify({
        version: 2,
        names: [CELL, PLASTIDS],
        missions: Array.from({ length: MAX_MISSIONS }, (_, i) => ({
          ...summary(`m${i}`, i, []),
          items: i === 0 ? [0, 1] : [1, 1],
        })),
      }),
    );
    loadHistory();
    appendSummary(summary("newest", MAX_MISSIONS, [{ uniqueName: RELIC, count: 1 }]));

    const stored = readJson("mission-history.json") as {
      names: string[];
      missions: { id: string; items: number[] }[];
    };
    expect(stored.missions).toHaveLength(MAX_MISSIONS);
    expect(stored.missions[0].id).toBe("m1");
    expect(stored.names).toEqual([PLASTIDS, RELIC]);
    expect(stored.missions.at(-1)?.items).toEqual([1, 1]);
    expect(recentSummaries(1)[0].items).toEqual([{ uniqueName: RELIC, count: 1 }]);
  });

  it("shows a recorded mission after a restart exactly as before it", () => {
    loadHistory();
    appendSummary(
      summary(
        "odd",
        1_000,
        [
          { uniqueName: PLASTIDS, count: 2 },
          { uniqueName: "not a path", count: 1 },
        ],
        { node: "Solar-Rail.1", missionType: "MT_SURVIVAL", baselineAt: 500 },
      ),
    );
    const before = recentSummaries(1);
    unloadHistory();
    loadHistory();

    expect(recentSummaries(1)).toEqual(before);
    expect(before[0].baselineAt).toBe(500);
    expect(before[0]).not.toHaveProperty("node");
    expect(before[0].items).toEqual([{ uniqueName: PLASTIDS, count: 2 }]);
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
        ],
      }),
    );

    loadHistory();

    const entries = recentSummaries(10);
    expect(entries.map((entry) => entry.id)).toEqual(["type", "ok"]);
    expect(entries[0]).not.toHaveProperty("missionType");
    expect(entries[0].node).toBe("SolNode25");
    expect(entries[1].items).toEqual([{ uniqueName: CELL, count: 3 }]);
  });

  it.each([
    ["not JSON", "{ not json"],
    ["an older version", JSON.stringify({ version: 1, names: [], missions: [] })],
    ["not a history", JSON.stringify([summary("a", 1_000, [])])],
  ])("moves a file that is %s aside and starts empty", (_label, contents) => {
    fs.writeFileSync(file("mission-history.json"), contents);
    loadHistory();
    expect(queryHistory({ offset: 0, limit: 1 }).recorded).toBe(0);

    appendSummary(summary("new", 2_000, []));
    const backups = fs.readdirSync(tmpDir).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(file(backups[0]), "utf8")).toBe(contents);
    expect(readJson("mission-history.json")).toMatchObject({
      version: 2,
      missions: [{ id: "new" }],
    });
  });

  it("leaves a file it could not read in place and does not write over it", () => {
    fs.mkdirSync(file("mission-history.json"));
    loadHistory();
    appendSummary(summary("this-session", 2_000, []));

    expect(recentSummaries(10).map((entry) => entry.id)).toEqual(["this-session"]);
    expect(fs.statSync(file("mission-history.json")).isDirectory()).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual(["mission-history.json"]);
  });

  it("keeps the first of two missions with the same id", () => {
    fs.writeFileSync(
      file("mission-history.json"),
      JSON.stringify({
        version: 2,
        names: [PLASTIDS, CELL],
        missions: [
          { ...summary("dup", 1_000, []), items: [0, 1] },
          { ...summary("other", 2_000, []), items: [] },
          { ...summary("dup", 3_000, []), items: [1, 1] },
        ],
      }),
    );
    loadHistory();

    const entries = recentSummaries(10);
    expect(entries.map((entry) => entry.id)).toEqual(["other", "dup"]);
    expect(entries[1].items).toEqual([{ uniqueName: PLASTIDS, count: 1 }]);
  });

  it("never replaces a history from a newer version", () => {
    const newer = JSON.stringify({ version: 3, missions: [{ id: "future" }] });
    fs.writeFileSync(file("mission-history.json"), newer);
    loadHistory();
    appendSummary(summary("this-session", 2_000, []));

    expect(recentSummaries(10).map((entry) => entry.id)).toEqual(["this-session"]);
    expect(fs.readFileSync(file("mission-history.json"), "utf8")).toBe(newer);
    expect(fs.readdirSync(tmpDir)).toEqual(["mission-history.json"]);
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
    expect(first.today).toBe(0);
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

  it("counts today's missions whatever the other filters match", () => {
    const page = queryHistory({
      offset: 0,
      limit: 10,
      missionType: "MT_DEFENSE",
      todaySince: 5 * DAY,
    });
    expect(page.matched).toBe(2);
    expect(page.today).toBe(3);
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
        todaySince: "midnight",
        missionType: "MT_DEFENSE; DROP",
        uniqueNames: [PLASTIDS, 3, "relative/path", "/".padEnd(300, "x")],
      }),
    ).toEqual({ offset: 5, limit: 200, uniqueNames: [PLASTIDS] });
    expect(
      normalizeMissionRewardsQuery({
        offset: 0,
        limit: 5,
        since: 10,
        todaySince: 20,
        missionType: "MT_SURVIVAL",
      }),
    ).toEqual({ offset: 0, limit: 5, since: 10, todaySince: 20, missionType: "MT_SURVIVAL" });
  });
});
