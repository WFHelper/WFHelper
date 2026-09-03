import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArbiRunRecord } from "../../config/shared/arbiTypes";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

type Tracker = typeof import("../../services/arbiRunTracker");

async function freshTracker(): Promise<Tracker> {
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  tracker.initArbiTracker();
  return tracker;
}

const missionLine = (ts: number, name: string) =>
  `${ts.toFixed(3)} Script [Info]: ThemedSquadOverlay.lua: Mission name: ${name}`;
const droneLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent7`;
const rewardLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: Created /Lotus/Interface/DefenseReward.swf`;
const eomLine = (ts: number) => `${ts.toFixed(3)} Sys [Info]: EOM missionLocationUnlocked=1`;

function waitForRun(tracker: Tracker): Promise<ArbiRunRecord> {
  return new Promise((resolve) => {
    tracker.setArbiCallbacks({ onRunSaved: resolve });
  });
}

/** Two rotations plus host AI lines, so the run clears the save gate. */
function feedRun(tracker: Tracker): void {
  tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
  tracker.processArbiLine(droneLine(150), "file");
  tracker.processArbiLine(droneLine(200), "file");
  tracker.processArbiLine(rewardLine(400), "file");
  tracker.processArbiLine(rewardLine(500), "file");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbi-test-"));
});

afterEach(async () => {
  vi.useRealTimers();
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("arbiRunTracker", () => {
  it("discards persisted log paths outside the run log directory", async () => {
    const externalPath = path.join(tmpDir, "outside.log.gz");
    fs.writeFileSync(externalPath, "keep");
    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            id: "2026-07-18_12-00-00",
            logFile: "../outside.log.gz",
            logSizeBytes: 4,
          },
        ],
      }),
    );

    const tracker = await freshTracker();
    expect(tracker.getRuns()[0]).toMatchObject({ logFile: null, logSizeBytes: 0 });
    expect(tracker.deleteRun("2026-07-18_12-00-00")).toBe(true);
    expect(fs.readFileSync(externalPath, "utf-8")).toBe("keep");
  });

  it("records a run and writes gz + index on new-mission finalize", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    const run = await saved;

    expect(run.node).toBe("Casta Defense (Ceres)");
    expect(run.missionType).toBe("defense");
    expect(run.drones).toBe(2);
    expect(run.rotations).toBe(2);
    expect(run.endReason).toBe("new-mission");
    expect(run.source).toBe("live");
    expect(run.logFile).toBe(`${run.id}.log.gz`);
    expect(run.logSizeBytes).toBeGreaterThan(0);

    const gzPath = path.join(tmpDir, "arbi-logs", run.logFile as string);
    const content = zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf-8");
    expect(content).toContain("Mission name: Arbitration: Casta Defense (Ceres)");
    expect(content).toContain("DefenseReward.swf");
    expect(content).not.toContain("Cetus (Earth)");

    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-runs.json"), "utf-8"));
    expect(index.schemaVersion).toBe(1);
    expect(index.runs).toHaveLength(1);
    expect(tracker.getRuns()[0].id).toBe(run.id);
    expect(tracker.getDiskUsageBytes()).toBe(run.logSizeBytes);
  });

  it("settles pending saves when the run-saved callback throws", async () => {
    const tracker = await freshTracker();
    let calls = 0;
    tracker.setArbiCallbacks({
      onRunSaved: () => {
        calls++;
        throw new Error("webContents destroyed mid-send");
      },
    });
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");

    await expect(tracker.awaitPendingArbiSaves()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(tracker.getRuns()).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "arbi-runs.json"))).toBe(true);
  });

  it("ignores lines while tracking is disabled, resumes when re-enabled", async () => {
    const tracker = await freshTracker();
    tracker.setArbiTrackingEnabled(false);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    expect(tracker.getRuns()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "arbi-logs"))).toBe(false);

    tracker.setArbiTrackingEnabled(true);
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    const run = await saved;
    expect(run.node).toBe("Casta Defense (Ceres)");
  });

  it("discards the in-progress capture when tracking is disabled mid-run", async () => {
    const tracker = await freshTracker();
    const onRunSaved = vi.fn();
    tracker.setArbiCallbacks({ onRunSaved });
    feedRun(tracker);
    // push past the flush threshold so the partial file exists on disk
    for (let i = 0; i < 200; i++) tracker.processArbiLine(droneLine(410 + i), "file");
    const logsDir = path.join(tmpDir, "arbi-logs");
    expect(fs.readdirSync(logsDir).some((f) => f.endsWith(".partial.log"))).toBe(true);

    tracker.setArbiTrackingEnabled(false);

    expect(tracker.getRuns()).toHaveLength(0);
    expect(fs.readdirSync(logsDir)).toHaveLength(0);
    expect(onRunSaved).not.toHaveBeenCalled();
  });

  it("ignores dbwin-source lines entirely", async () => {
    const tracker = await freshTracker();
    tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "dbwin");
    expect(fs.existsSync(path.join(tmpDir, "arbi-logs"))).toBe(false);
    expect(tracker.getRuns()).toHaveLength(0);
  });

  it("finalizes as aborted on a confirmed abort line", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine("500.000 Script [Info]: TopMenu.lua: Abort: host/no session", "file");
    const run = await saved;
    expect(run.endReason).toBe("aborted");
    expect(run.rotations).toBe(2);
  });

  it("finalizes with log-truncated on EE.log reset", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.notifyEeLogReset();
    const run = await saved;
    expect(run.endReason).toBe("log-truncated");
    expect(run.rotations).toBe(2);
  });

  it("finalizes synchronously on shutdown", async () => {
    const tracker = await freshTracker();
    let saved: ArbiRunRecord | null = null;
    tracker.setArbiCallbacks({ onRunSaved: (r) => (saved = r) });
    feedRun(tracker);
    tracker.shutdownArbiTracker();
    expect(saved).not.toBeNull();
    expect((saved as unknown as ArbiRunRecord).endReason).toBe("app-quit");
    expect(fs.existsSync(path.join(tmpDir, "arbi-runs.json"))).toBe(true);
  });

  it("saves neither a client-side run nor one under two rotations", async () => {
    const tracker = await freshTracker();

    // Client-side: no OnAgentCreated lines at all, however many rotations.
    tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
    tracker.processArbiLine(rewardLine(400), "file");
    tracker.processArbiLine(rewardLine(500), "file");
    tracker.processArbiLine(rewardLine(600), "file");
    tracker.processArbiLine(eomLine(700), "file");

    // Host-side but only one rotation.
    tracker.processArbiLine(missionLine(1000, "Arbitration: Casta Defense (Ceres)"), "file");
    tracker.processArbiLine(droneLine(1050), "file");
    tracker.processArbiLine(rewardLine(1400), "file");
    tracker.processArbiLine(eomLine(1500), "file");

    await new Promise((r) => setTimeout(r, 50));
    expect(tracker.getRuns()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "arbi-runs.json"))).toBe(false);
    const logsDir = path.join(tmpDir, "arbi-logs");
    const leftovers = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
    expect(leftovers).toEqual([]);
  });

  it("starts a back-to-back arbitration from the ending mission line", async () => {
    const tracker = await freshTracker();
    const first = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(
      missionLine(900, "Arbitration: Berehynia Interception (Sedna)"),
      "file",
    );
    const run = await first;
    expect(run.node).toBe("Casta Defense (Ceres)");

    const second = waitForRun(tracker);
    tracker.processArbiLine(droneLine(950), "file");
    tracker.processArbiLine(rewardLine(1000), "file");
    tracker.processArbiLine(rewardLine(1100), "file");
    tracker.notifyEeLogReset();
    const run2 = await second;
    expect(run2.node).toBe("Berehynia Interception (Sedna)");
    expect(run2.missionType).toBe("interception");
    expect(run2.drones).toBe(1);
    // Same wall-clock second must not collide on capture paths.
    expect(run2.id).not.toBe(run.id);
  });

  it("records two runs separated by a mission-end (finish arbi, queue the next)", async () => {
    const tracker = await freshTracker();
    const first = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(eomLine(500), "file");
    const run1 = await first;
    expect(run1.node).toBe("Casta Defense (Ceres)");
    expect(run1.endReason).toBe("mission-end");

    const second = waitForRun(tracker);
    tracker.processArbiLine(
      missionLine(900, "Arbitration: Berehynia Interception (Sedna)"),
      "file",
    );
    tracker.processArbiLine(droneLine(950), "file");
    tracker.processArbiLine(rewardLine(1100), "file");
    tracker.processArbiLine(rewardLine(1150), "file");
    tracker.processArbiLine(eomLine(1200), "file");
    const run2 = await second;
    expect(run2.node).toBe("Berehynia Interception (Sedna)");
    expect(run2.endReason).toBe("mission-end");
    expect(run2.id).not.toBe(run1.id);
    expect(tracker.getRuns()).toHaveLength(2);

    // Each capture holds only its own run's lines.
    const gz1 = zlib
      .gunzipSync(fs.readFileSync(path.join(tmpDir, "arbi-logs", run1.logFile as string)))
      .toString("utf-8");
    expect(gz1).toContain("Casta Defense");
    expect(gz1).not.toContain("Berehynia");
  });

  it("finalizes via inactivity when only non-combat lines keep arriving", async () => {
    vi.useFakeTimers();
    const tracker = await freshTracker();
    let saved: ArbiRunRecord | null = null;
    tracker.setArbiCallbacks({ onRunSaved: (r) => (saved = r) });
    feedRun(tracker);

    // Orbiter chatter keeps the log flowing but must not keep the run alive.
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(60_000);
      tracker.processArbiLine(`${900 + i}.000 Sys [Info]: orbiter chatter`, "file");
    }

    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 50));
    expect(saved).not.toBeNull();
    expect((saved as unknown as ArbiRunRecord).endReason).toBe("inactivity");
  });

  it("stays alive while combat events keep arriving", async () => {
    vi.useFakeTimers();
    const tracker = await freshTracker();
    let saved: ArbiRunRecord | null = null;
    tracker.setArbiCallbacks({ onRunSaved: (r) => (saved = r) });
    feedRun(tracker);

    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(60_000);
      tracker.processArbiLine(droneLine(900 + i * 60), "file");
    }

    expect(saved).toBeNull();
    vi.useRealTimers();
  });

  it("salvages a stale partial capture on init", async () => {
    const logsDir = path.join(tmpDir, "arbi-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const partial = [
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      droneLine(150),
      rewardLine(400),
      rewardLine(500),
    ].join("\n");
    fs.writeFileSync(path.join(logsDir, "2026-01-01_10-00-00.partial.log"), partial, "utf-8");

    const tracker = await freshTracker();
    const runs = tracker.getRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].endReason).toBe("log-truncated");
    expect(runs[0].rotations).toBe(2);
    expect(fs.readdirSync(logsDir).some((f) => f.endsWith(".partial.log"))).toBe(false);
    expect(fs.readdirSync(logsDir).some((f) => f.endsWith(".log.gz"))).toBe(true);
  });

  it("supports vitus update, log delete and run delete", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    const run = await saved;

    const updated = tracker.setRunVitus(run.id, 1044);
    expect(updated?.vitusActual).toBe(1044);
    expect(tracker.setRunVitus("nope", 1)).toBeNull();

    const afterLogDelete = tracker.deleteRunLog(run.id);
    expect(afterLogDelete?.logFile).toBeNull();
    expect(afterLogDelete?.logSizeBytes).toBe(0);
    expect(tracker.getDiskUsageBytes()).toBe(0);
    expect(tracker.getRunLogPath(run.id)).toBeNull();

    expect(tracker.deleteRun(run.id)).toBe(true);
    expect(tracker.getRuns()).toHaveLength(0);
    expect(tracker.deleteRun(run.id)).toBe(false);
  });

  it("sets, normalizes, and clears run tags; persists across reload", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    const run = await saved;

    // Dupes (case-insensitive) and blanks are dropped; order preserved.
    const tagged = tracker.setRunTags(run.id, ["Boar Run", "boar run", "  ", "steel path"]);
    expect(tagged?.tags).toEqual(["Boar Run", "steel path"]);
    expect(tracker.setRunTags("nope", ["x"])).toBeNull();

    // Reload from the on-disk index to prove persistence.
    const reloaded = await freshTracker();
    expect(reloaded.getRuns()[0]?.tags).toEqual(["Boar Run", "steel path"]);

    // Empty list removes the field entirely.
    const cleared = reloaded.setRunTags(run.id, []);
    expect(cleared?.tags).toBeUndefined();
    const reloadedAgain = await freshTracker();
    expect(reloadedAgain.getRuns()[0]?.tags).toBeUndefined();
  });

  it("backfills players on pre-squad records from the stored log, once", async () => {
    const logsDir = path.join(tmpDir, "arbi-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = [
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      "105.000 Game [Info]: HostPlayer loadout loader finished.",
      "112.000 Game [Info]: ClientOne loadout loader finished.",
      droneLine(150),
      rewardLine(400),
      rewardLine(700),
    ].join("\n");
    fs.writeFileSync(path.join(logsDir, "2026-07-08_00-15-00.log.gz"), zlib.gzipSync(lines));
    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          { id: "2026-07-08_00-15-00", logFile: "2026-07-08_00-15-00.log.gz", logSizeBytes: 10 },
          { id: "2026-07-08_01-15-00", logFile: null, logSizeBytes: 0 },
        ],
      }),
    );

    const tracker = await freshTracker();
    await tracker.__arbiBackfillForTest();
    expect(tracker.getRuns()[0]?.players).toEqual(["HostPlayer", "ClientOne"]);
    // No log to read from: marked processed with an empty list.
    expect(tracker.getRuns()[1]?.players).toEqual([]);
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-runs.json"), "utf-8"));
    expect(index.runs[0].players).toEqual(["HostPlayer", "ClientOne"]);

    // A reload must not re-parse: names survive without the log file.
    fs.rmSync(path.join(logsDir, "2026-07-08_00-15-00.log.gz"));
    const reloaded = await freshTracker();
    await reloaded.__arbiBackfillForTest();
    expect(reloaded.getRuns()[0]?.players).toEqual(["HostPlayer", "ClientOne"]);
  });

  it("keeps a pre-notes, pre-duplicate record readable and writes notes onto it", async () => {
    const startedAt = new Date("2026-07-08T00:15:00").getTime();
    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            id: "2026-07-08_00-15-00",
            startedAt,
            endedAt: startedAt + 600_000,
            missionName: "Arbitration: Casta Defense (Ceres)",
            node: "Casta Defense (Ceres)",
            missionType: "defense",
            durationSec: 600,
            rotations: 3,
            drones: 12,
            totalEnemies: 240,
            vitusActual: null,
            logFile: null,
            logSizeBytes: 0,
            endReason: "mission-end",
            source: "live",
            stats: {
              killsPerDrone: 20,
              avgDroneIntervalSec: 30,
              expectedVitusMean: 10,
              expectedVitusStd: 3,
              vitusPerMin: 1,
              wavesPerRotation: 3,
              droneTimestamps: [10, 40],
              rewardTimestamps: [100],
              preciseStartSec: 0,
              lastActivitySec: 200,
              saturationBuckets: [],
              waves: null,
            },
          },
        ],
      }),
    );

    const tracker = await freshTracker();
    const [run] = tracker.getRuns();
    expect(run.notes).toBeUndefined();
    expect(run.duplicateOf).toBeUndefined();
    // The new stats fields stay absent rather than being invented.
    expect(run.stats?.pauseIntervals).toBeUndefined();
    expect(run.stats?.idleIntervals).toBeUndefined();

    expect(tracker.setRunNotes(run.id, "  boar build\u0000 test  ")?.notes).toBe("boar build test");
    const reloaded = await freshTracker();
    expect(reloaded.getRuns()[0]?.notes).toBe("boar build test");
    expect(reloaded.getRuns()[0]?.stats?.droneTimestamps).toEqual([10, 40]);
  });

  it("caps notes and drops the field when cleared", async () => {
    const tracker = await freshTracker();
    feedRun(tracker);
    const saved = waitForRun(tracker);
    tracker.processArbiLine(eomLine(900), "file");
    const run = await saved;

    expect(tracker.setRunNotes(run.id, "x".repeat(2500))?.notes).toHaveLength(2000);
    expect(tracker.setRunNotes(run.id, "   ")?.notes).toBeUndefined();
    expect(tracker.setRunNotes("nope", "hi")).toBeNull();
  });

  it("marks the poorer of a live/imported pair as a duplicate and frees it on delete", async () => {
    const startedAt = new Date("2026-07-08T00:15:00").getTime();
    const record = (
      id: string,
      overrides: Partial<ArbiRunRecord> & Pick<ArbiRunRecord, "source">,
    ) => ({
      id,
      startedAt,
      endedAt: startedAt + 600_000,
      missionName: "Arbitration: Casta Defense (Ceres)",
      node: "Casta Defense (Ceres)",
      missionType: "defense",
      durationSec: 600,
      rotations: 3,
      drones: 12,
      totalEnemies: 240,
      vitusActual: null,
      logFile: null,
      logSizeBytes: 0,
      endReason: "mission-end",
      stats: null,
      ...overrides,
    });

    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          // Same mission: 60s apart, 2s of duration drift. Only the live one has stats.
          record("2026-07-08_00-15-00", {
            source: "live",
            stats: {
              killsPerDrone: 20,
              avgDroneIntervalSec: 30,
              expectedVitusMean: 10,
              expectedVitusStd: 3,
              vitusPerMin: 1,
              wavesPerRotation: 3,
              droneTimestamps: [],
              rewardTimestamps: [],
              preciseStartSec: 0,
              lastActivitySec: 600,
              saturationBuckets: [],
              waves: null,
            },
          }),
          record("2026-07-08_00-16-00", {
            source: "imported",
            startedAt: startedAt + 60_000,
            durationSec: 602,
          }),
          // Same node but three hours later: a separate run, not a duplicate.
          record("2026-07-08_03-15-00", {
            source: "imported",
            startedAt: startedAt + 3 * 3600_000,
          }),
        ],
      }),
    );

    const tracker = await freshTracker();
    const byId = new Map(tracker.getRuns().map((r) => [r.id, r]));
    expect(byId.get("2026-07-08_00-15-00")?.duplicateOf).toBeUndefined();
    expect(byId.get("2026-07-08_00-16-00")?.duplicateOf).toBe("2026-07-08_00-15-00");
    expect(byId.get("2026-07-08_03-15-00")?.duplicateOf).toBeUndefined();

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-runs.json"), "utf-8"));
    expect(
      persisted.runs.find((r: ArbiRunRecord) => r.id === "2026-07-08_00-16-00").duplicateOf,
    ).toBe("2026-07-08_00-15-00");

    expect(tracker.deleteRun("2026-07-08_00-15-00")).toBe(true);
    expect(
      tracker.getRuns().find((r) => r.id === "2026-07-08_00-16-00")?.duplicateOf,
    ).toBeUndefined();
  });

  it("backfills cadence intervals onto pre-cadence records, taking nothing else", async () => {
    const logsDir = path.join(tmpDir, "arbi-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = [
      missionLine(100, "Arbitration: Casta Defense (Ceres)"),
      "110.000 Script [Info]: WaveDefend.lua: Defense wave: 1",
      droneLine(120),
      droneLine(130),
      "140.000 Script [Info]: WaveDefend.lua: _SleepBetweenWaves",
      "160.000 Script [Info]: WaveDefend.lua: Starting wave 2 (32 simultaneous)",
      "200.000 AI [Info]: NpcManager status MonitoredTicking 5",
      // 90s without a tick line becomes an idle window.
      "290.000 AI [Info]: NpcManager status MonitoredTicking 6",
      rewardLine(400),
      "430.000 Script [Info]: WaveDefend.lua: Starting wave 4 (32 simultaneous)",
      rewardLine(700),
      droneLine(750),
    ].join("\n");
    fs.writeFileSync(path.join(logsDir, "2026-07-08_00-15-00.log.gz"), zlib.gzipSync(lines));

    const startedAt = new Date("2026-07-08T00:15:00").getTime();
    const legacyStats = {
      killsPerDrone: 7,
      avgDroneIntervalSec: 31.5,
      expectedVitusMean: 12.5,
      expectedVitusStd: 3.25,
      vitusPerMin: 1.25,
      wavesPerRotation: 3,
      droneTimestamps: [120, 130, 750],
      rewardTimestamps: [400, 700],
      preciseStartSec: 110,
      lastActivitySec: 750,
      saturationBuckets: [{ minCount: 0, label: "0-2", seconds: 5, pct: 100 }],
      waves: null,
    };
    const record = (id: string, overrides: Record<string, unknown>) => ({
      id,
      startedAt,
      endedAt: startedAt + 600_000,
      missionName: "Arbitration: Casta Defense (Ceres)",
      node: "Casta Defense (Ceres)",
      missionType: "defense",
      durationSec: 640,
      rotations: 2,
      drones: 3,
      totalEnemies: 21,
      vitusActual: null,
      logFile: null,
      logSizeBytes: 0,
      endReason: "mission-end",
      source: "live",
      players: [],
      stats: JSON.parse(JSON.stringify(legacyStats)),
      ...overrides,
    });

    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          record("2026-07-08_00-15-00", {
            logFile: "2026-07-08_00-15-00.log.gz",
            logSizeBytes: 40,
          }),
          // Log already deleted: nothing to re-read, so the timeline stays hidden.
          record("2026-07-08_01-15-00", {}),
          // Already carries intervals: must be left exactly as stored.
          record("2026-07-08_02-15-00", {
            logFile: "2026-07-08_00-15-00.log.gz",
            logSizeBytes: 40,
            stats: {
              ...JSON.parse(JSON.stringify(legacyStats)),
              pauseIntervals: [{ start: 1, end: 2 }],
              idleIntervals: [],
            },
          }),
        ],
      }),
    );

    const tracker = await freshTracker();
    await tracker.__arbiBackfillForTest();
    const byId = new Map(tracker.getRuns().map((r) => [r.id, r]));

    const filled = byId.get("2026-07-08_00-15-00");
    expect(filled?.stats?.pauseIntervals).toEqual([
      { start: 140, end: 160 },
      { start: 400, end: 430 },
      { start: 700, end: 750 },
    ]);
    expect(filled?.stats?.idleIntervals).toEqual([{ start: 200, end: 290 }]);
    // Every other field keeps the stored value, not a re-parsed one.
    const { pauseIntervals: _p, idleIntervals: _i, ...rest } = filled?.stats ?? {};
    expect(rest).toEqual(legacyStats);
    expect(filled?.drones).toBe(3);
    expect(filled?.durationSec).toBe(640);

    expect(byId.get("2026-07-08_01-15-00")?.stats?.pauseIntervals).toBeUndefined();
    expect(byId.get("2026-07-08_01-15-00")?.stats?.idleIntervals).toBeUndefined();

    // A record that already has intervals is skipped, so its values survive.
    expect(byId.get("2026-07-08_02-15-00")?.stats?.pauseIntervals).toEqual([{ start: 1, end: 2 }]);

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, "arbi-runs.json"), "utf-8"));
    const stored = persisted.runs.find(
      (r: ArbiRunRecord) => r.id === "2026-07-08_00-15-00",
    ) as ArbiRunRecord;
    expect(stored.stats?.idleIntervals).toEqual([{ start: 200, end: 290 }]);

    // Second launch has nothing left to read: deleting the log changes nothing.
    fs.rmSync(path.join(logsDir, "2026-07-08_00-15-00.log.gz"));
    const reloaded = await freshTracker();
    await reloaded.__arbiBackfillForTest();
    expect(
      reloaded.getRuns().find((r) => r.id === "2026-07-08_00-15-00")?.stats?.pauseIntervals,
    ).toEqual([
      { start: 140, end: 160 },
      { start: 400, end: 430 },
      { start: 700, end: 750 },
    ]);
  });

  it("leaves stats-less records out of the cadence backfill", async () => {
    const logsDir = path.join(tmpDir, "arbi-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "2026-07-08_00-15-00.log.gz"),
      zlib.gzipSync(
        [missionLine(100, "Arbitration: Casta Defense (Ceres)"), droneLine(120)].join("\n"),
      ),
    );
    const startedAt = new Date("2026-07-08T00:15:00").getTime();
    fs.writeFileSync(
      path.join(tmpDir, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            id: "2026-07-08_00-15-00",
            startedAt,
            endedAt: startedAt + 600_000,
            missionName: "Arbitration: Oestrus (Eris)",
            node: "Oestrus (Eris)",
            missionType: "other",
            durationSec: 600,
            rotations: 3,
            drones: 5,
            totalEnemies: 50,
            vitusActual: null,
            logFile: "2026-07-08_00-15-00.log.gz",
            logSizeBytes: 20,
            endReason: "mission-end",
            source: "live",
            players: [],
            stats: null,
          },
        ],
      }),
    );

    const tracker = await freshTracker();
    await tracker.__arbiBackfillForTest();
    expect(tracker.getRuns()[0]?.stats).toBeNull();
  });

  it("awaitPendingArbiSaves resolves immediately when nothing is in flight", async () => {
    const tracker = await freshTracker();
    await expect(tracker.awaitPendingArbiSaves()).resolves.toBeUndefined();
  });

  it("awaitPendingArbiSaves resolves only after the finalized record lands in getRuns()", async () => {
    const tracker = await freshTracker();
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    // The gzip pipeline is async, so the record has not landed synchronously.
    expect(tracker.getRuns()).toHaveLength(0);
    await tracker.awaitPendingArbiSaves();
    expect(tracker.getRuns()).toHaveLength(1);
    expect(tracker.getRuns()[0].node).toBe("Casta Defense (Ceres)");
  });
});
