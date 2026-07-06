import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(first.endReason).toBe("imported");
    // anchor 12:00:00 at ts 0.5 -> run start ts 100 = 12:01:39.5 local
    const anchored = new Date(2026, 2, 1, 12, 0, 0).getTime() - 500 + 100_000;
    expect(first.startedAt).toBe(anchored);
    expect(first.id).toBe("2026-03-01_12-01-39");

    expect(second.node).toBe("Berehynia Interception (Sedna)");
    expect(second.missionType).toBe("interception");
    expect(second.rotations).toBe(1);

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
