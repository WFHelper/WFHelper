import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dumpRewardScanDebug,
  pruneScanDebugBundles,
  setOcrDebugDumpsEnabled,
  setScanDebugDirForTest,
} from "../../services/rewardScanDebug";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-scan-debug-"));
  setScanDebugDirForTest(dir);
  setOcrDebugDumpsEnabled(true);
});

afterEach(() => {
  setScanDebugDirForTest(null);
  setOcrDebugDumpsEnabled(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitForBundle(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (entries.length > 0 && fs.existsSync(path.join(dir, entries[0], "meta.json"))) {
      return path.join(dir, entries[0]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("dump bundle never appeared");
}

describe("pruneScanDebugBundles", () => {
  it("removes oldest bundles beyond the cap", () => {
    for (let i = 1; i <= 5; i++) {
      fs.mkdirSync(path.join(dir, `2026-01-0${i}_00-00-00-000`));
    }
    pruneScanDebugBundles(dir, 3);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "2026-01-03_00-00-00-000",
      "2026-01-04_00-00-00-000",
      "2026-01-05_00-00-00-000",
    ]);
  });

  it("tolerates a missing root", () => {
    expect(() => pruneScanDebugBundles(path.join(dir, "nope"), 3)).not.toThrow();
  });
});

describe("dumpRewardScanDebug", () => {
  it("is a no-op while dumps are disabled", async () => {
    setOcrDebugDumpsEnabled(false);
    dumpRewardScanDebug("empty-slots", [], { reader: "both" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("writes strips plus meta, omitting buffers from the json", async () => {
    dumpRewardScanDebug(
      "empty-slots",
      [
        {
          index: 0,
          stripPng: Buffer.from("png-bytes"),
          windowsText: "Wukon Chassis",
          onnxText: "Wukong Prime Chassis Blueprint",
          diverged: true,
          matchedName: null,
          confidence: null,
          mode: null,
        },
        {
          index: 1,
          stripPng: null,
          windowsText: "Forma Blueprint",
          onnxText: "Forma Blueprint",
          diverged: false,
          matchedName: "Forma Blueprint",
          confidence: 0.98,
          mode: "exact",
        },
      ],
      { reader: "both", layoutCount: 2 },
    );

    const bundle = await waitForBundle();
    expect(fs.existsSync(path.join(bundle, "slot1.png"))).toBe(true);
    expect(fs.existsSync(path.join(bundle, "slot2.png"))).toBe(false);

    const meta = JSON.parse(fs.readFileSync(path.join(bundle, "meta.json"), "utf8"));
    expect(meta.reason).toBe("empty-slots");
    expect(meta.reader).toBe("both");
    expect(meta.slots).toHaveLength(2);
    expect(meta.slots[0].hasStrip).toBe(true);
    expect(meta.slots[0].stripPng).toBeUndefined();
    expect(meta.slots[1].matchedName).toBe("Forma Blueprint");
  });
});
