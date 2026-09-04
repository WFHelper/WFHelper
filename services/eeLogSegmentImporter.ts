import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { finished } from "node:stream/promises";
import type { ScopedLogger } from "./logger";
import { EE_LOG_LINE_TS } from "./arbiRunParser";
import { normalizeErrorMessage } from "../config/shared/errors";

/** EE.log header, e.g. "0.234 Sys [Diag]: Current time: Fri Jul 04 12:34:56 2026 [UTC: Fri Jul 04 10:34:56 2026]". */
const CURRENT_TIME = /Sys \[Diag\]: Current time: (.+?)(?: \[UTC: (.+?)\])?\s*$/;

const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;

export interface SegmentImportOptions {
  maxSegmentBytes?: number;
  tempRoot?: string;
}

type SegmentEvent<TReason> = { type: "run-start" } | { type: "run-end"; reason: TReason };

interface SegmentParser<TParsed, TReason> {
  feedLine(line: string): SegmentEvent<TReason> | null;
  isRunActive(): boolean;
  finalize(): TParsed | null;
  reset(): void;
}

/** What a feature has to supply to reuse the split-an-EE.log-into-runs machinery. */
interface SegmentImportSpec<TParsed, TReason, TRecord> {
  log: ScopedLogger;
  /** Log prefix, e.g. "[Arbi]". */
  label: string;
  tempPrefix: string;
  defaultReason: TReason;
  createParser(): SegmentParser<TParsed, TReason>;
  /** Game-time seconds a run starts at; anchored against the header timestamp. */
  runStartSec(parsed: TParsed): number;
  addRun(
    parsed: TParsed,
    startedAt: number,
    segmentPath: string,
    reason: TReason,
  ): Promise<TRecord | null>;
}

interface SegmentCapture {
  path: string;
  stream: fs.WriteStream;
  bytes: number;
  truncated: boolean;
  error: Error | null;
}

/** Splits an external EE.log into per-run segments and hands each to `spec.addRun`. */
export async function importEeLogSegments<TParsed, TReason, TRecord>(
  filePath: string,
  spec: SegmentImportSpec<TParsed, TReason, TRecord>,
  options: SegmentImportOptions = {},
): Promise<{ imported: TRecord[]; skipped: number }> {
  const imported: TRecord[] = [];
  let skipped = 0;
  const maxSegmentBytes =
    typeof options.maxSegmentBytes === "number" &&
    Number.isFinite(options.maxSegmentBytes) &&
    options.maxSegmentBytes > 0
      ? Math.min(Math.floor(options.maxSegmentBytes), MAX_SEGMENT_BYTES)
      : MAX_SEGMENT_BYTES;
  const tempDir = await fs.promises.mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), spec.tempPrefix),
  );

  let mtimeMs = Date.now();
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // keep Date.now fallback
  }

  const parser = spec.createParser();
  let gameTimeZeroMs: number | null = null;
  let lastTs = 0;
  let segment: SegmentCapture | null = null;
  let segmentIndex = 0;

  function computeStartedAt(parsed: TParsed): number {
    const runStartSec = spec.runStartSec(parsed);
    if (gameTimeZeroMs !== null) return gameTimeZeroMs + runStartSec * 1000;
    // No header timestamp: anchor the file's last line to its mtime.
    return mtimeMs - Math.max(0, lastTs - runStartSec) * 1000;
  }

  async function closeSegment(): Promise<string | null> {
    const capture = segment;
    segment = null;
    if (!capture) return null;
    capture.stream.end();
    await finished(capture.stream);
    return capture.path;
  }

  async function discardSegment(): Promise<void> {
    const capture = segment;
    segment = null;
    if (!capture) return;
    capture.stream.destroy();
    try {
      await finished(capture.stream);
    } catch {
      // Cleanup must continue after a stream failure.
    }
    try {
      await fs.promises.unlink(capture.path);
    } catch {
      // The stream may not have created the file.
    }
  }

  async function finishRun(reason: TReason): Promise<void> {
    const parsed = parser.finalize();
    const segmentPath = await closeSegment();
    if (!parsed || !segmentPath) return;
    const record = await spec.addRun(parsed, computeStartedAt(parsed), segmentPath, reason);
    if (record) imported.push(record);
    else skipped++;
  }

  async function captureLine(line: string): Promise<void> {
    if (!segment || segment.truncated) return;
    if (segment.error) throw segment.error;
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (segment.bytes + bytes > maxSegmentBytes) {
      segment.truncated = true;
      spec.log.warn(`${spec.label} Imported run segment exceeds cap - raw capture truncated`);
      return;
    }
    segment.bytes += bytes;
    if (!segment.stream.write(`${line}\n`, "utf8")) {
      await once(segment.stream, "drain");
    }
  }

  async function startSegment(line: string): Promise<void> {
    await discardSegment();
    const segmentPath = path.join(tempDir, `segment-${segmentIndex++}.log`);
    const capture: SegmentCapture = {
      path: segmentPath,
      stream: fs.createWriteStream(segmentPath, { encoding: "utf8" }),
      bytes: 0,
      truncated: false,
      error: null,
    };
    capture.stream.on("error", (error) => {
      capture.error = error;
    });
    segment = capture;
    await captureLine(line);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (gameTimeZeroMs === null) {
        const timeMatch = line.match(CURRENT_TIME);
        if (timeMatch) {
          // Prefer the UTC stamp: the first one is the log author's local time,
          // which is wrong for logs shared from another timezone.
          const utc = timeMatch[2] ? new Date(`${timeMatch[2].trim()} GMT`).getTime() : NaN;
          const wall = Number.isFinite(utc) ? utc : new Date(timeMatch[1].trim()).getTime();
          const tsMatch = line.match(EE_LOG_LINE_TS);
          const ts = tsMatch ? parseFloat(tsMatch[1]) : 0;
          if (Number.isFinite(wall)) gameTimeZeroMs = wall - ts * 1000;
        }
      }
      const tsMatch = line.match(EE_LOG_LINE_TS);
      if (tsMatch) lastTs = Math.max(lastTs, parseFloat(tsMatch[1]));

      const event = parser.feedLine(line);
      if (event?.type === "run-start") {
        await startSegment(line);
        continue;
      }
      if (event?.type === "run-end") {
        await finishRun(event.reason);
        const next = parser.feedLine(line);
        if (next?.type === "run-start") {
          await startSegment(line);
        }
        continue;
      }
      if (parser.isRunActive()) await captureLine(line);
    }

    if (parser.isRunActive()) await finishRun(spec.defaultReason);
  } catch (err) {
    spec.log.warn(`${spec.label} Import failed:`, normalizeErrorMessage(err));
    parser.reset();
    await discardSegment();
  } finally {
    rl.close();
    stream.destroy();
    await discardSegment();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  spec.log.info(
    `${spec.label} Import done: ${imported.length} run(s) imported, ${skipped} skipped`,
  );
  return { imported, skipped };
}
