import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpDir,
  },
}));

const missionLine = (ts: number, name: string) =>
  `${ts.toFixed(3)} Script [Info]: ThemedSquadOverlay.lua: Mission name: ${name}`;
const droneLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent7`;
const rewardLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: Created /Lotus/Interface/DefenseReward.swf`;

// Anchor: game time 0 = 2026-03-01 12:00:00 local (header line at ts 0.5).
const HEADER = "0.500 Sys [Diag]: Current time: Sun Mar 01 12:00:00 2026 [UTC: Sun Mar 01 11:00:00 2026]";

function multiRunLog(): string {
  return [
    HEADER,
    "5.000 Sys [Info]: Some unrelated line",
    missionLine(100, "Arbitration: Casta Defense (Ceres)"),
    droneLine(150),
    droneLine(200),
    rewardLine(400),
    missionLine(900, "Cetus (Earth)"),
    "950.000 Sys [Info]: idle in town",
    missionLine(1000, "Arbitration: Berehynia Interception (Sedna)"),
    droneLine(1100),
    droneLine(1160),
    rewardLine(1400),
    // file ends while second run is active
  ].join("\n");
}

async function freshImporter() {
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  tracker.initArbiTracker();
  const importer = await import("../../services/arbiLogImporter");
  return { tracker, importer };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbi-import-test-"));
});

afterEach(async () => {
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("arbiLogImporter", () => {
  it("extracts all runs from a multi-run EE.log with wall-clock anchoring", async () => {
    const { tracker, importer } = await freshImporter();
    const logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(logPath, multiRunLog(), "utf-8");

    const result = await importer.importEeLog(logPath);
    expect(result.skipped).toBe(0);
    expect(result.imported).toHaveLength(2);

    const [first, second] = result.imported;
    expect(first.node).toBe("Casta Defense (Ceres)");
    expect(first.missionType).toBe("defense");
    expect(first.drones).toBe(2);
    expect(first.source).toBe("imported");
    // The first run's end was observed (next mission line); the reason carries over.
    expect(first.endReason).toBe("new-mission");
    // anchor 12:00:00 at ts 0.5 -> run start ts 100 = 12:01:39.5 local
    const anchored = new Date(2026, 2, 1, 12, 0, 0).getTime() - 500 + 100_000;
    expect(first.startedAt).toBe(anchored);
    expect(first.id).toBe("2026-03-01_12-01-39");

    expect(second.node).toBe("Berehynia Interception (Sedna)");
    expect(second.missionType).toBe("interception");
    expect(second.rotations).toBe(1);
    // File ended mid-run: no observed end.
    expect(second.endReason).toBe("imported");

    // gz segments written and scoped to their run
    const logsDir = path.join(tmpDir, "arbi-logs");
    expect(fs.readdirSync(logsDir).filter((f) => f.endsWith(".log.gz"))).toHaveLength(2);
    expect(tracker.getRuns()).toHaveLength(2);
  });

  it("skips already-imported runs on re-import", async () => {
    const { importer } = await freshImporter();
    const logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(logPath, multiRunLog(), "utf-8");

    const first = await importer.importEeLog(logPath);
    expect(first.imported).toHaveLength(2);

    const again = await importer.importEeLog(logPath);
    expect(again.imported).toHaveLength(0);
    expect(again.skipped).toBe(2);
  });

  it("imports nothing from a log without arbitrations", async () => {
    const { importer } = await freshImporter();
    const logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(
      logPath,
      [HEADER, missionLine(100, "Cetus (Earth)"), droneLine(150)].join("\n"),
      "utf-8",
    );
    const result = await importer.importEeLog(logPath);
    expect(result.imported).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("imports a real aborted run with type, node id and end reason", async () => {
    const { importer } = await freshImporter();
    const fixture = path.join(__dirname, "..", "fixtures", "arbi", "oestrus-abort-ee.log");

    const result = await importer.importEeLog(fixture);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toBe(0);

    const run = result.imported[0];
    expect(run.node).toBe("Oestrus (Eris)");
    expect(run.missionType).toBe("other");
    expect(run.missionTypeRaw).toBe("MT_PURIFY");
    expect(run.solNode).toBe("SolNode167");
    expect(run.endReason).toBe("aborted");
    expect(run.stats).toBeNull();
    expect(run.drones).toBe(0);
    // FlightAgents never advanced MonitoredTicking - the post-pass drops them.
    expect(run.totalEnemies).toBe(0);
    // Header anchor 11:40:31 at ts 0.102 -> run start ts 178.428 = 11:43:29 local.
    expect(run.id).toBe("2026-07-06_11-43-29");

    const gz = fs.readFileSync(path.join(tmpDir, "arbi-logs", `${run.id}.log.gz`));
    const raw = zlib.gunzipSync(gz).toString("utf-8");
    expect(raw).toContain("Oestrus (Eris) - Arbitration");
    expect(raw).toContain("AbortMissionConfirm");
    expect(raw).not.toContain("Isos (Eris)");
  });

  it("imports a real survival run past the in-mission EndOfMatch screens", async () => {
    const { importer } = await freshImporter();
    const fixture = path.join(__dirname, "..", "fixtures", "arbi", "mot-survival-ee.log");

    const result = await importer.importEeLog(fixture);
    expect(result.imported).toHaveLength(1);

    const run = result.imported[0];
    expect(run.node).toBe("Mot (Void)");
    expect(run.missionType).toBe("other");
    expect(run.missionTypeRaw).toBe("MT_SURVIVAL");
    expect(run.solNode).toBe("SolNode409");
    // The EndOfMatch.lua screens at 432/577 must not have ended the run.
    expect(run.endReason).toBe("mission-end");
    expect(run.rotations).toBe(1);
    expect(run.drones).toBe(7);
    // first drone 434.607 -> last drone 735.957
    expect(run.durationSec).toBeCloseTo(301.35, 2);
    expect(run.id).toBe("2026-07-06_17-53-23");
  });

  it("falls back to file mtime when the header is missing", async () => {
    const { importer } = await freshImporter();
    const logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(
      logPath,
      [missionLine(100, "Arbitration: Casta Defense (Ceres)"), droneLine(150)].join("\n"),
      "utf-8",
    );
    const mtimeMs = fs.statSync(logPath).mtimeMs;
    const result = await importer.importEeLog(logPath);
    expect(result.imported).toHaveLength(1);
    // last line ts 150, run start ts 100 -> startedAt = mtime - 50s
    expect(result.imported[0].startedAt).toBeCloseTo(mtimeMs - 50_000, -2);
  });
});
