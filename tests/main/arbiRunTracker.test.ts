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

function waitForRun(tracker: Tracker): Promise<ArbiRunRecord> {
  return new Promise((resolve) => {
    tracker.setArbiCallbacks({ onRunSaved: resolve });
  });
}

function feedRun(tracker: Tracker): void {
  tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
  tracker.processArbiLine(droneLine(150), "file");
  tracker.processArbiLine(droneLine(200), "file");
  tracker.processArbiLine(rewardLine(400), "file");
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
  it("records a run and writes gz + index on new-mission finalize", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    const run = await saved;

    expect(run.node).toBe("Casta Defense (Ceres)");
    expect(run.missionType).toBe("defense");
    expect(run.drones).toBe(2);
    expect(run.rotations).toBe(1);
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
    expect(run.rotations).toBe(1);
  });

  it("finalizes with log-truncated on EE.log reset", async () => {
    const tracker = await freshTracker();
    const saved = waitForRun(tracker);
    feedRun(tracker);
    tracker.notifyEeLogReset();
    const run = await saved;
    expect(run.endReason).toBe("log-truncated");
    expect(run.rotations).toBe(1);
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

  it("starts a back-to-back arbitration from the ending mission line", async () => {
    const tracker = await freshTracker();
    const first = waitForRun(tracker);
    feedRun(tracker);
    tracker.processArbiLine(missionLine(900, "Arbitration: Berehynia Interception (Sedna)"), "file");
    const run = await first;
    expect(run.node).toBe("Casta Defense (Ceres)");

    const second = waitForRun(tracker);
    tracker.processArbiLine(droneLine(950), "file");
    tracker.notifyEeLogReset();
    const run2 = await second;
    expect(run2.node).toBe("Berehynia Interception (Sedna)");
    expect(run2.missionType).toBe("interception");
    expect(run2.drones).toBe(1);
    // Same wall-clock second must not collide on capture paths.
    expect(run2.id).not.toBe(run.id);
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
    ].join("\n");
    fs.writeFileSync(path.join(logsDir, "2026-01-01_10-00-00.partial.log"), partial, "utf-8");

    const tracker = await freshTracker();
    const runs = tracker.getRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].endReason).toBe("log-truncated");
    expect(runs[0].rotations).toBe(1);
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
});
