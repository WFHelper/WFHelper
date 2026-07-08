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

// Anchor: game time 0 = 2026-03-01 11:00:00 UTC (header line at ts 0.5).
const HEADER = "0.500 Sys [Diag]: Current time: Sun Mar 01 12:00:00 2026 [UTC: Sun Mar 01 11:00:00 2026]";

// Mirror of the tracker's id format: startedAt rendered in this machine's local time.
const fmtId = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
};

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
    // anchor on the UTC stamp: 11:00:00Z at ts 0.5 -> run start ts 100 = 11:01:39.5Z
    const anchored = Date.UTC(2026, 2, 1, 11, 0, 0) - 500 + 100_000;
    expect(first.startedAt).toBe(anchored);
    expect(first.id).toBe(fmtId(anchored));

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
    // Header anchor [UTC: 09:40:31] at ts 0.102 -> run start ts 178.428.
    const startedAt = Date.UTC(2026, 6, 6, 9, 40, 31) - 102 + 178_428;
    expect(run.startedAt).toBe(startedAt);
    expect(run.id).toBe(fmtId(startedAt));

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
    const startedAt = Date.UTC(2026, 6, 6, 15, 46, 29) - 91 + 415_070;
    expect(run.id).toBe(fmtId(startedAt));
  });

  it("imports a real interception run ignoring the stray survival reward UI", async () => {
    const { importer } = await freshImporter();
    const fixture = path.join(__dirname, "..", "fixtures", "arbi", "rhea-interception-ee.log");

    const result = await importer.importEeLog(fixture);
    expect(result.imported).toHaveLength(1);

    const run = result.imported[0];
    expect(run.node).toBe("Rhea (Saturn)");
    expect(run.missionType).toBe("interception");
    expect(run.missionTypeRaw).toBe("MT_TERRITORY");
    expect(run.solNode).toBe("SolNode18");
    expect(run.endReason).toBe("mission-end");
    expect(run.rotations).toBe(1);
    expect(run.drones).toBe(5);
    // The rotation anchors on the DefenseReward, not the stray SurvivalReward.
    expect(run.stats?.rewardTimestamps).toEqual([356.94]);
    expect(run.stats?.preciseStartSec).toBe(133.194);
    // first territory control 133.194 -> reward 356.940 (matches the reference site)
    expect(run.durationSec).toBeCloseTo(223.746, 3);
  });

  it("imports a real defense run with wave map and foreign-timezone anchor", async () => {
    const { importer } = await freshImporter();
    const fixture = path.join(__dirname, "..", "fixtures", "arbi", "stoefler-defense-ee.log");

    const result = await importer.importEeLog(fixture);
    expect(result.imported).toHaveLength(1);

    const run = result.imported[0];
    expect(run.node).toBe("Stöfler (Lua)");
    expect(run.missionType).toBe("defense");
    expect(run.missionTypeRaw).toBe("MT_DEFENSE");
    expect(run.solNode).toBe("SolNode305");
    expect(run.endReason).toBe("mission-end");
    expect(run.rotations).toBe(2);
    expect(run.drones).toBe(3);
    // 2x ShieldLancer + 2x ShotgunLancer + 3 drones; the kubrow also counts -
    // a single spawn can never be proven non-ticking (reference-site parity).
    expect(run.totalEnemies).toBe(8);

    const s = run.stats;
    expect(s).not.toBeNull();
    expect(s?.wavesPerRotation).toBe(3);
    expect(s?.rewardTimestamps).toEqual([16855.934, 16936.816]);
    // "Defense wave: 1" is the precise start.
    expect(s?.preciseStartSec).toBe(16786.896);
    expect(run.durationSec).toBeCloseTo(16936.816 - 16786.896, 3);

    // Wave durations: sleep-marker windows, every 3rd wave via countdown-5.
    const waves = s?.waves ?? [];
    expect(waves.map((w) => w.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(waves[0].durationSec).toBeCloseTo(16.151, 3);
    expect(waves[1].durationSec).toBeCloseTo(22.873, 3);
    expect(waves[2].durationSec).toBeCloseTo(16855.932 - 5 - 16831.973, 3);
    // Wave 4 ends on a "!"-prefixed sleep line - the timestamp must still parse.
    expect(waves[3].durationSec).toBeCloseTo(19.101, 3);
    expect(waves[5].durationSec).toBeCloseTo(16936.807 - 5 - 16910.236, 3);

    // The header is from another machine (UTC-6): anchor must use the UTC stamp.
    const startedAt = Date.UTC(2026, 6, 7, 21, 40, 49) - 127 + 16_596_750;
    expect(run.startedAt).toBe(startedAt);
    expect(run.id).toBe(fmtId(startedAt));
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
