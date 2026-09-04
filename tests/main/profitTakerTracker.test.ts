import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PtRunRecord } from "../../config/shared/profitTakerTypes";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

type Tracker = typeof import("../../services/profitTakerTracker");

async function freshTracker(): Promise<Tracker> {
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  tracker.initPtTracker();
  return tracker;
}

const FIXTURE = path.join(__dirname, "..", "fixtures", "pt", "host-single-run.log");

function fixtureLines(): string[] {
  return fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/);
}

function feedFixture(tracker: Tracker): void {
  for (const line of fixtureLines()) tracker.processProfitTakerLine(line, "file");
}

const ts = (value: number) => value.toFixed(3);
const sessionLine = (t: number) =>
  `${ts(t)} Script [Info]: EidolonMP.lua: Session map string: /Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyFour`;
const phaseLine = (t: number, which: string) =>
  `${ts(t)} Script [Info]: CamperHeistOrbFight.lua: Orb Fight - Starting ${which} attack Orb phase`;
const eomLine = (t: number) => `${ts(t)} Sys [Info]: EOM missionLocationUnlocked=1`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-test-"));
});

afterEach(async () => {
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("profitTakerTracker", () => {
  it("indexes a completed host run and gzips its capture", async () => {
    const tracker = await freshTracker();
    const saved: PtRunRecord[] = [];
    tracker.setPtCallbacks({ onRunSaved: (run) => saved.push(run) });

    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();

    expect(tracker.getPtRuns()).toHaveLength(1);
    const [run] = tracker.getPtRuns();
    expect(saved).toEqual([run]);
    expect(run.complete).toBe(true);
    expect(run.solo).toBe(false);
    expect(run.durationSec).toBeCloseTo(112.971, 2);
    expect(run.phases).toHaveLength(4);
    expect(run.endReason).toBe("completed");
    expect(run.source).toBe("live");
    expect(run.logFile).toBe(`${run.id}.log.gz`);
    expect(run.logSizeBytes).toBeGreaterThan(0);

    const gz = path.join(tmpDir, "pt-logs", run.logFile as string);
    const captured = zlib.gunzipSync(fs.readFileSync(gz)).toString("utf-8");
    expect(captured).toContain("Orb Fight - Starting final attack Orb phase");
    // The index survives a reload.
    tracker.__resetPtTrackerForTest();
    tracker.initPtTracker();
    expect(tracker.getPtRuns()).toHaveLength(1);
  });

  it("ignores dbwin-sourced lines", async () => {
    const tracker = await freshTracker();
    for (const line of fixtureLines()) tracker.processProfitTakerLine(line, "dbwin");
    await tracker.awaitPendingPtSaves();
    expect(tracker.getPtRuns()).toEqual([]);
  });

  it("does not save a client-side run", async () => {
    const tracker = await freshTracker();
    tracker.processProfitTakerLine(sessionLine(10), "file");
    tracker.processProfitTakerLine(phaseLine(20, "first"), "file");
    tracker.processProfitTakerLine(phaseLine(30, "second"), "file");
    tracker.processProfitTakerLine(eomLine(40), "file");
    await tracker.awaitPendingPtSaves();

    expect(tracker.getPtRuns()).toEqual([]);
    // The partial capture is removed with the run.
    expect(fs.readdirSync(path.join(tmpDir, "pt-logs"))).toEqual([]);
  });

  it("drops a capture the player armed but never entered", async () => {
    const tracker = await freshTracker();
    tracker.processProfitTakerLine(
      `${ts(5)} Script [Info]: ThemedSquadOverlay.lua: Active jobId set to /Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyFour_-6`,
      "file",
    );
    tracker.processProfitTakerLine(
      `${ts(9)} Game [Info]: HostPlayer loadout loader finished.`,
      "file",
    );
    tracker.processProfitTakerLine(
      `${ts(20)} Script [Info]: EidolonMP.lua: EIDOLONMP: TryTownTransition(1)`,
      "file",
    );
    await tracker.awaitPendingPtSaves();
    expect(tracker.getPtRuns()).toEqual([]);
  });

  it("discards the in-flight capture when tracking is turned off", async () => {
    const tracker = await freshTracker();
    tracker.processProfitTakerLine(sessionLine(10), "file");
    tracker.setPtTrackingEnabled(false);
    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    expect(tracker.getPtRuns()).toEqual([]);
  });

  it("normalises tags and notes and clears them on empty input", async () => {
    const tracker = await freshTracker();
    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    const [run] = tracker.getPtRuns();

    expect(tracker.setPtRunTags(run.id, ["  Sub 2  ", "sub 2", ""])?.tags).toEqual(["Sub 2"]);
    expect(tracker.setPtRunTags(run.id, [])?.tags).toBeUndefined();
    expect(tracker.setPtRunNotes(run.id, "  bad pylons  ")?.notes).toBe("bad pylons");
    expect(tracker.setPtRunNotes(run.id, "  ")?.notes).toBeUndefined();
    expect(tracker.setPtRunTags("nope", ["x"])).toBeNull();
    expect(tracker.setPtRunNotes("nope", "x")).toBeNull();
  });

  it("deletes the raw log without losing the record, then the record itself", async () => {
    const tracker = await freshTracker();
    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    const [run] = tracker.getPtRuns();
    const gz = tracker.getPtRunLogPath(run.id);
    expect(gz).not.toBeNull();

    expect(tracker.deletePtRunLog(run.id)?.logFile).toBeNull();
    expect(fs.existsSync(gz as string)).toBe(false);
    expect(tracker.getPtRuns()).toHaveLength(1);
    expect(tracker.getPtDiskUsageBytes()).toBe(0);

    expect(tracker.deletePtRun(run.id)).toBe(true);
    expect(tracker.deletePtRun(run.id)).toBe(false);
    expect(tracker.getPtRuns()).toEqual([]);
  });

  it("links an imported copy of a live run as a duplicate", async () => {
    const tracker = await freshTracker();
    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    const [live] = tracker.getPtRuns();

    const segment = path.join(tmpDir, "segment.log");
    fs.writeFileSync(segment, fixtureLines().join("\n"));
    const { createProfitTakerParser } = await import("../../services/profitTakerParser");
    const parser = createProfitTakerParser();
    for (const line of fixtureLines()) parser.feedLine(line);
    const parsed = parser.finalize();
    expect(parsed).not.toBeNull();

    // One minute apart, same duration: inside the live-vs-imported window.
    const imported = await tracker.addImportedPtRunFromFile(
      parsed!,
      live.startedAt + 60_000,
      segment,
    );
    expect(imported).not.toBeNull();
    expect(tracker.getPtRuns()).toHaveLength(2);
    const duplicates = tracker.getPtRuns().filter((run) => run.duplicateOf !== undefined);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].duplicateOf).not.toBe(duplicates[0].id);
  });

  it("discards persisted log paths outside the run log directory", async () => {
    const externalPath = path.join(tmpDir, "outside.log.gz");
    fs.writeFileSync(externalPath, "keep");
    fs.writeFileSync(
      path.join(tmpDir, "pt-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            id: "2026-09-04_12-00-00",
            phases: [],
            logFile: "../outside.log.gz",
            logSizeBytes: 4,
          },
        ],
      }),
    );

    const tracker = await freshTracker();
    const [run] = tracker.getPtRuns();
    expect(run.logFile).toBeNull();
    expect(tracker.getPtRunLogPath(run.id)).toBeNull();
    expect(fs.existsSync(externalPath)).toBe(true);
  });

  it("salvages a partial capture left behind by a crash", async () => {
    const logsDir = path.join(tmpDir, "pt-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "2026-09-04_10-00-00.partial.log"),
      fixtureLines().join("\n"),
    );

    const tracker = await freshTracker();
    expect(tracker.getPtRuns()).toHaveLength(1);
    expect(tracker.getPtRuns()[0].endReason).toBe("log-truncated");
    expect(fs.readdirSync(logsDir).filter((f) => f.endsWith(".partial.log"))).toEqual([]);
  });
});
