/**
 * Batch-extract arbitration runs from an external EE.log file.
 * Streams the file line by line through the pure parser and persists every
 * detected run via arbiRunTracker (deduped by wall-clock id).
 */

import fs from "node:fs";
import readline from "node:readline";
import { withScope } from "./logger";
import { createArbiParser } from "./arbiRunParser";
import type { ArbiParsedRun } from "./arbiRunParser";
import { addImportedRun } from "./arbiRunTracker";
import type { ArbiImportResult, ArbiRunEndReason } from "../config/shared/arbiTypes";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("arbiLogImporter");

/** EE.log header, e.g. "0.234 Sys [Diag]: Current time: Fri Jul 04 12:34:56 2026 [UTC: Fri Jul 04 10:34:56 2026]". */
const CURRENT_TIME = /Sys \[Diag\]: Current time: (.+?)(?: \[UTC: (.+?)\])?\s*$/;
const LINE_TS = /^[^\d]*(\d+\.\d+)/;

/** Hard cap on buffered segment size per run (raw text) to bound memory. */
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

interface WallClockAnchor {
  /** Wall-clock epoch ms corresponding to game time 0. */
  gameTimeZeroMs: number;
}

export async function importEeLog(filePath: string): Promise<ArbiImportResult> {
  const imported: ArbiImportResult["imported"] = [];
  let skipped = 0;

  let mtimeMs = Date.now();
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // keep Date.now fallback
  }

  const parser = createArbiParser();
  let anchor: WallClockAnchor | null = null;
  let lastTs = 0;
  let segment: string[] = [];
  let segmentBytes = 0;
  let segmentTruncated = false;

  function computeStartedAt(parsed: ArbiParsedRun): number {
    if (anchor) return anchor.gameTimeZeroMs + parsed.runStartSec * 1000;
    // No header timestamp: anchor the file's last line to its mtime.
    return mtimeMs - Math.max(0, lastTs - parsed.runStartSec) * 1000;
  }

  // "imported" marks runs whose end was never observed (file ended mid-run).
  function finishRun(endReason: ArbiRunEndReason = "imported"): void {
    const parsed = parser.finalize();
    if (!parsed) return;
    const raw = segment.join("\n") + "\n";
    segment = [];
    segmentBytes = 0;
    segmentTruncated = false;
    const record = addImportedRun(parsed, computeStartedAt(parsed), raw, endReason);
    if (record) imported.push(record);
    else skipped++;
  }

  function captureLine(line: string): void {
    if (segmentTruncated) return;
    segmentBytes += line.length + 1;
    if (segmentBytes > MAX_SEGMENT_BYTES) {
      segmentTruncated = true;
      log.warn("[Arbi] Imported run segment exceeds cap - raw capture truncated");
      return;
    }
    segment.push(line);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!anchor) {
        const timeMatch = line.match(CURRENT_TIME);
        if (timeMatch) {
          // Prefer the UTC stamp: the first one is the log author's local time,
          // which is wrong for logs shared from another timezone.
          const utc = timeMatch[2] ? new Date(`${timeMatch[2].trim()} GMT`).getTime() : NaN;
          const wall = Number.isFinite(utc) ? utc : new Date(timeMatch[1].trim()).getTime();
          const tsMatch = line.match(LINE_TS);
          const ts = tsMatch ? parseFloat(tsMatch[1]) : 0;
          if (Number.isFinite(wall)) anchor = { gameTimeZeroMs: wall - ts * 1000 };
        }
      }
      const tsMatch = line.match(LINE_TS);
      if (tsMatch) lastTs = Math.max(lastTs, parseFloat(tsMatch[1]));

      const event = parser.feedLine(line);
      if (event?.type === "run-start") {
        segment = [line];
        segmentBytes = line.length + 1;
        segmentTruncated = false;
        continue;
      }
      if (event?.type === "run-end") {
        finishRun(event.reason);
        // Back-to-back arbitration: the ending line may start the next run.
        const next = parser.feedLine(line);
        if (next?.type === "run-start") {
          segment = [line];
          segmentBytes = line.length + 1;
          segmentTruncated = false;
        }
        continue;
      }
      if (parser.isRunActive()) captureLine(line);
    }

    if (parser.isRunActive()) finishRun();
  } catch (err) {
    log.warn("[Arbi] Import failed:", normalizeErrorMessage(err));
    parser.reset();
  } finally {
    rl.close();
    stream.destroy();
  }

  log.info(`[Arbi] Import done: ${imported.length} run(s) imported, ${skipped} skipped`);
  return { imported, skipped };
}
