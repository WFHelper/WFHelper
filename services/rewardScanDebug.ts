/**
 * Failed/diverging reward scans dump strip crops + read texts to
 * <userData>/scan-debug/<stamp>/; size-capped, oldest pruned.
 */

import fs from "node:fs";
import path from "node:path";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("rewardScanDebug");

const MAX_BUNDLES = 25;

export interface ScanDebugSlot {
  index: number;
  stripPng: Buffer | null;
  windowsText: string;
  onnxText: string;
  diverged: boolean;
  matchedName: string | null;
  confidence: number | null;
  mode: string | null;
}

let _dirOverride: string | null = null;

/** Test hook - point the dump root somewhere writable without electron. */
export function setScanDebugDirForTest(dir: string | null): void {
  _dirOverride = dir;
}

export function getScanDebugDir(): string {
  if (_dirOverride) return _dirOverride;
  const { app } = require("electron") as typeof import("electron");
  return path.join(app.getPath("userData"), "scan-debug");
}

/** Delete oldest bundle dirs beyond the cap. Exported for tests. */
export function pruneScanDebugBundles(rootDir: string, maxBundles: number): void {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // stamps sort chronologically
  } catch {
    return;
  }
  const excess = entries.length - maxBundles;
  for (let i = 0; i < excess; i++) {
    try {
      fs.rmSync(path.join(rootDir, entries[i]), { recursive: true, force: true });
    } catch {
      /* leave stragglers for the next prune */
    }
  }
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * Fire-and-forget dump. Strips only - never the full frame (it can contain
 * squad member names).
 */
export function dumpRewardScanDebug(
  reason: string,
  slots: ScanDebugSlot[],
  meta: Record<string, unknown>,
): void {
  void (async () => {
    try {
      const root = getScanDebugDir();
      const dir = path.join(root, stampNow());
      await fs.promises.mkdir(dir, { recursive: true });
      for (const slot of slots) {
        if (slot.stripPng) {
          await fs.promises.writeFile(path.join(dir, `slot${slot.index + 1}.png`), slot.stripPng);
        }
      }
      const metaOut = {
        reason,
        ...meta,
        slots: slots.map(({ stripPng, ...rest }) => ({ ...rest, hasStrip: !!stripPng })),
      };
      await fs.promises.writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify(metaOut, null, 2),
        "utf8",
      );
      pruneScanDebugBundles(root, MAX_BUNDLES);
      log.info(`[ScanDebug] saved ${reason} bundle: ${dir}`);
    } catch (err) {
      log.warn("[ScanDebug] dump failed:", normalizeErrorMessage(err));
    }
  })();
}
