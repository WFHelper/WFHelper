import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

const FIXTURES = path.join(__dirname, "..", "fixtures", "pt");

async function freshImporter() {
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  tracker.initPtTracker();
  const importer = await import("../../services/profitTakerLogImporter");
  return { tracker, importer };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-import-test-"));
});

afterEach(async () => {
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("profitTakerLogImporter", () => {
  it("imports every Profit-Taker run out of a shared EE.log", async () => {
    const { importer, tracker } = await freshImporter();
    const result = await importer.importProfitTakerLog(path.join(FIXTURES, "host-two-runs.log"), {
      tempRoot: tmpDir,
    });

    expect(result.imported).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(tracker.getPtRuns()).toHaveLength(2);
    expect(result.imported.map((run) => run.source)).toEqual(["imported", "imported"]);
    expect(result.imported.map((run) => run.endReason)).toEqual(["completed", "completed"]);
    expect(result.imported[0].durationSec).toBeCloseTo(112.971, 2);
    expect(result.imported[1].durationSec).toBeCloseTo(100.618, 2);
    expect(result.imported[1].solo).toBe(true);
  });

  it("anchors the run's wall clock on the log header", async () => {
    const { importer } = await freshImporter();
    const result = await importer.importProfitTakerLog(path.join(FIXTURES, "host-single-run.log"), {
      tempRoot: tmpDir,
    });

    expect(result.imported).toHaveLength(1);
    // Header: game time 0.5 = 2026-03-01 11:00:00 UTC, so run start 5316.394s in.
    const expected = Date.UTC(2026, 2, 1, 11, 0, 0) - 500 + 5316.394 * 1000;
    expect(result.imported[0].startedAt).toBeCloseTo(expected, -1);
    expect(result.imported[0].endedAt - result.imported[0].startedAt).toBeCloseTo(112_971, -1);
  });

  it("skips a run it has already imported", async () => {
    const { importer, tracker } = await freshImporter();
    const file = path.join(FIXTURES, "host-single-run.log");
    expect((await importer.importProfitTakerLog(file, { tempRoot: tmpDir })).imported).toHaveLength(
      1,
    );
    const again = await importer.importProfitTakerLog(file, { tempRoot: tmpDir });
    expect(again.imported).toHaveLength(0);
    expect(again.skipped).toBe(1);
    expect(tracker.getPtRuns()).toHaveLength(1);
  });

  it("returns an empty result for a log with no Profit-Taker runs", async () => {
    const other = path.join(tmpDir, "other.log");
    fs.writeFileSync(
      other,
      ["1.000 Sys [Info]: nothing here", "2.000 Sys [Info]: still nothing"].join("\n"),
    );
    const { importer } = await freshImporter();
    const result = await importer.importProfitTakerLog(other, { tempRoot: tmpDir });
    expect(result).toEqual({ imported: [], skipped: 0 });
  });

  it("returns an empty result for a missing file", async () => {
    const { importer } = await freshImporter();
    const result = await importer.importProfitTakerLog(path.join(tmpDir, "missing.log"), {
      tempRoot: tmpDir,
    });
    expect(result).toEqual({ imported: [], skipped: 0 });
  });
});
