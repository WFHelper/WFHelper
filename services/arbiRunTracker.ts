/**
 * Arbitration run lifecycle: consumes EE.log lines from eeLogMonitor, captures
 * the raw log segment of each run to arbi-logs/<id>.log.gz, computes stats via
 * the pure parser, and persists the run index to arbi-runs.json.
 */

import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { app } from "electron";
import { withScope } from "./logger";
import { writeFileAtomicSync } from "./atomicFile";
import { createArbiParser } from "./arbiRunParser";
import type { ArbiParsedRun, ArbiParser } from "./arbiRunParser";
import type { ArbiRunEndReason, ArbiRunRecord } from "../config/shared/arbiTypes";
import { normalizeArbiTags } from "../config/shared/arbiTypes";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("arbiRunTracker");

const INDEX_SCHEMA_VERSION = 1;
/** Flush the capture buffer to the partial file every N lines (crash-safety vs syscall spam). */
const FLUSH_EVERY_LINES = 200;
/** Finalize a run when no combat events arrive for this long - fallback for
 * ends the parser markers miss (e.g. crash to desktop, connection loss). */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const INACTIVITY_CHECK_MS = 60_000;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/;

interface ActiveRun {
  id: string;
  startedAt: number;
  runStartSec: number;
  partialPath: string;
  pendingLines: string[];
  /** Wall clock of the last combat event (not last log line - the orbiter keeps
   * logging after a mission, which must not keep the run alive). */
  lastCombatAt: number;
  lastActivityCount: number;
}

interface ArbiCallbacks {
  onRunSaved: ((run: ArbiRunRecord) => void) | null;
}

let _parser: ArbiParser | null = null;
let _active: ActiveRun | null = null;
let _runs: ArbiRunRecord[] = [];
/** Ids reserved before their record lands in _runs (gzip in flight); prevents
 * back-to-back runs in the same wall-clock second from sharing capture files. */
const _reservedIds = new Set<string>();
let _callbacks: ArbiCallbacks = { onRunSaved: null };
let _inactivityTimer: ReturnType<typeof setInterval> | null = null;
let _initialized = false;
let _trackingEnabled = true;

function _indexPath(): string {
  return path.join(app.getPath("userData"), "arbi-runs.json");
}

function _logsDir(): string {
  return path.join(app.getPath("userData"), "arbi-logs");
}

function _gzPath(id: string): string {
  return path.join(_logsDir(), `${id}.log.gz`);
}

function _storedLogPath(run: Pick<ArbiRunRecord, "id" | "logFile">): string | null {
  if (!RUN_ID_RE.test(run.id) || run.logFile !== `${run.id}.log.gz`) return null;
  const logsDir = path.resolve(_logsDir());
  const candidate = path.resolve(logsDir, run.logFile);
  return path.dirname(candidate) === logsDir ? candidate : null;
}

function _formatRunId(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

function _uniqueRunId(date: Date): string {
  const base = _formatRunId(date);
  let id = base;
  let n = 2;
  while (_runs.some((r) => r.id === id) || _reservedIds.has(id)) id = `${base}-${n++}`;
  _reservedIds.add(id);
  return id;
}

function _saveIndex(): void {
  try {
    const payload = { schemaVersion: INDEX_SCHEMA_VERSION, runs: _runs };
    writeFileAtomicSync(_indexPath(), JSON.stringify(payload));
  } catch (err) {
    log.warn("[Arbi] Failed to save run index:", normalizeErrorMessage(err));
  }
}

function _loadIndex(): void {
  try {
    if (!fs.existsSync(_indexPath())) return;
    const raw: unknown = JSON.parse(fs.readFileSync(_indexPath(), "utf-8"));
    if (!raw || typeof raw !== "object") return;
    const runs = (raw as { runs?: unknown }).runs;
    if (!Array.isArray(runs)) return;
    _runs = runs
      .filter(
        (r): r is ArbiRunRecord =>
          !!r &&
          typeof r === "object" &&
          typeof (r as { id?: unknown }).id === "string" &&
          RUN_ID_RE.test((r as { id: string }).id),
      )
      .map((run) =>
        run.logFile == null || _storedLogPath(run)
          ? run
          : { ...run, logFile: null, logSizeBytes: 0 },
      );
  } catch (err) {
    log.warn("[Arbi] Failed to load run index:", normalizeErrorMessage(err));
    try {
      // keep the unreadable file so the next save cannot clobber the only copy
      fs.renameSync(_indexPath(), `${_indexPath()}.corrupt-${Date.now()}`);
    } catch {
      // rename is best effort
    }
    _runs = [];
  }
}

function _flushPending(run: ActiveRun): void {
  if (run.pendingLines.length === 0) return;
  try {
    fs.appendFileSync(run.partialPath, run.pendingLines.join("\n") + "\n", "utf-8");
  } catch (err) {
    log.warn("[Arbi] Failed to append capture lines:", normalizeErrorMessage(err));
  }
  run.pendingLines = [];
}

function _buildRecord(
  run: { id: string; startedAt: number },
  parsed: ArbiParsedRun,
  endReason: ArbiRunEndReason,
  logSizeBytes: number,
): ArbiRunRecord {
  const endSec = parsed.runEndSec ?? parsed.lastActivitySec;
  const gameElapsedMs = Math.max(0, (endSec - parsed.runStartSec) * 1000);
  return {
    id: run.id,
    startedAt: run.startedAt,
    endedAt: run.startedAt + gameElapsedMs,
    missionName: parsed.missionName,
    node: parsed.node,
    missionType: parsed.missionType,
    missionTypeRaw: parsed.missionTypeRaw,
    solNode: parsed.solNode,
    durationSec: parsed.durationSec,
    rotations: parsed.rotations,
    drones: parsed.drones,
    totalEnemies: parsed.totalEnemies,
    vitusActual: null,
    logFile: logSizeBytes > 0 ? `${run.id}.log.gz` : null,
    logSizeBytes,
    endReason,
    source: "live",
    stats: parsed.stats,
  };
}

function _addRecord(record: ArbiRunRecord): void {
  _runs.unshift(record);
  _saveIndex();
  log.info(
    `[Arbi] Run saved: ${record.node} (${record.missionType}), ` +
      `${record.rotations} rotations, ${record.drones} drones, end=${record.endReason}`,
  );
  if (_callbacks.onRunSaved) _callbacks.onRunSaved(record);
}

function _stopInactivityTimer(): void {
  if (_inactivityTimer) {
    clearInterval(_inactivityTimer);
    _inactivityTimer = null;
  }
}

function _startInactivityTimer(): void {
  _stopInactivityTimer();
  _inactivityTimer = setInterval(() => {
    if (_active && Date.now() - _active.lastCombatAt > INACTIVITY_TIMEOUT_MS) {
      log.info("[Arbi] No combat events for 10min - finalizing");
      _finalizeRun("inactivity", false);
    }
  }, INACTIVITY_CHECK_MS);
  if (typeof _inactivityTimer.unref === "function") _inactivityTimer.unref();
}

function _gzipPartialAsync(
  partialPath: string,
  gzTarget: string,
  done: (size: number) => void,
): void {
  pipeline(
    fs.createReadStream(partialPath),
    zlib.createGzip(),
    fs.createWriteStream(gzTarget),
    (err) => {
      if (err) {
        log.warn("[Arbi] gzip of run capture failed:", normalizeErrorMessage(err));
        done(0);
        return;
      }
      try {
        fs.unlinkSync(partialPath);
      } catch {
        // leftover partial is harmless; salvage ignores runs already indexed via gz
      }
      let size: number;
      try {
        size = fs.statSync(gzTarget).size;
      } catch {
        size = 0;
      }
      done(size);
    },
  );
}

function _finalizeRun(endReason: ArbiRunEndReason, sync: boolean): void {
  if (!_active || !_parser) return;
  const run = _active;
  _active = null;
  _stopInactivityTimer();

  const parsed = _parser.finalize();
  if (!parsed) return;

  _flushPending(run);

  if (sync) {
    // App-quit path: no event loop left for streams.
    let size = 0;
    try {
      fs.writeFileSync(_gzPath(run.id), zlib.gzipSync(fs.readFileSync(run.partialPath)));
      fs.unlinkSync(run.partialPath);
      size = fs.statSync(_gzPath(run.id)).size;
    } catch (err) {
      log.warn("[Arbi] sync gzip failed:", normalizeErrorMessage(err));
    }
    _addRecord(_buildRecord(run, parsed, endReason, size));
    return;
  }

  _gzipPartialAsync(run.partialPath, _gzPath(run.id), (size) => {
    _addRecord(_buildRecord(run, parsed, endReason, size));
  });
}

function _startCapture(gameTimeSec: number, firstLine: string): void {
  const now = new Date();
  const id = _uniqueRunId(now);
  try {
    fs.mkdirSync(_logsDir(), { recursive: true });
  } catch {
    // mkdir failure surfaces on first append below
  }
  _active = {
    id,
    startedAt: now.getTime(),
    runStartSec: gameTimeSec,
    partialPath: path.join(_logsDir(), `${id}.partial.log`),
    pendingLines: [firstLine],
    lastCombatAt: Date.now(),
    lastActivityCount: 0,
  };
  _startInactivityTimer();
  log.info(`[Arbi] Run started: ${id}`);
}

export function processArbiLine(line: string, source: "dbwin" | "file"): void {
  // File-poll lines are complete, ordered and deduped; dbwin duplicates them.
  if (!_trackingEnabled || source !== "file" || !_initialized) return;
  if (!_parser) _parser = createArbiParser();

  const event = _parser.feedLine(line);

  if (event?.type === "run-start") {
    _startCapture(event.gameTimeSec, line);
    return;
  }

  if (event?.type === "run-end") {
    _finalizeRun(event.reason, false);
    // Back-to-back arbitrations: the ending line may itself start the next run.
    const next = _parser.feedLine(line);
    if (next?.type === "run-start") _startCapture(next.gameTimeSec, line);
    return;
  }

  if (_active) {
    _active.pendingLines.push(line);
    const count = _parser.activityCount();
    if (count !== _active.lastActivityCount) {
      _active.lastActivityCount = count;
      _active.lastCombatAt = Date.now();
    }
    if (_active.pendingLines.length >= FLUSH_EVERY_LINES) _flushPending(_active);
  }
}

/** Drop the in-progress capture without saving a record (opt-out mid-run). */
function _discardActiveRun(): void {
  if (!_active) return;
  const run = _active;
  _active = null;
  _stopInactivityTimer();
  _parser = null;
  _reservedIds.delete(run.id);
  try {
    fs.unlinkSync(run.partialPath);
  } catch {
    // nothing flushed yet -> no file
  }
  log.info(`[Arbi] Run capture discarded: ${run.id}`);
}

/** Full opt-out: ignore EE.log lines and drop any in-progress capture. */
export function setArbiTrackingEnabled(enabled: boolean): void {
  if (_trackingEnabled === enabled) return;
  _trackingEnabled = enabled;
  log.info(`[Arbi] Run tracking ${enabled ? "enabled" : "disabled"}`);
  if (!enabled) _discardActiveRun();
}

/** EE.log was truncated or unlinked (game restart) - finalize with what we have. */
export function notifyEeLogReset(): void {
  if (_active) {
    log.info("[Arbi] EE.log reset mid-run - finalizing");
    _finalizeRun("log-truncated", false);
  }
}

export function shutdownArbiTracker(): void {
  if (_active) _finalizeRun("app-quit", true);
  _stopInactivityTimer();
  _parser = null;
  _callbacks = { onRunSaved: null };
  _initialized = false;
}

export function setArbiCallbacks(cbs: Partial<ArbiCallbacks>): void {
  _callbacks = { ..._callbacks, ...cbs };
}

/** Reparse partial capture files left behind by a crash into proper records. */
function _salvageStalePartials(): void {
  let files: string[];
  try {
    files = fs.readdirSync(_logsDir()).filter((f) => f.endsWith(".partial.log"));
  } catch {
    return;
  }
  for (const file of files) {
    const partialPath = path.join(_logsDir(), file);
    try {
      const content = fs.readFileSync(partialPath, "utf-8");
      const parser = createArbiParser();
      for (const line of content.split(/\r?\n/)) parser.feedLine(line);
      const parsed = parser.finalize();
      if (!parsed) {
        fs.unlinkSync(partialPath);
        continue;
      }
      const mtime = fs.statSync(partialPath).mtimeMs;
      const gameElapsedMs = Math.max(0, (parsed.lastActivitySec - parsed.runStartSec) * 1000);
      const startedAt = mtime - gameElapsedMs;
      const id = _uniqueRunId(new Date(startedAt));
      fs.writeFileSync(_gzPath(id), zlib.gzipSync(content));
      fs.unlinkSync(partialPath);
      const size = fs.statSync(_gzPath(id)).size;
      _addRecord(_buildRecord({ id, startedAt }, parsed, "log-truncated", size));
      log.info(`[Arbi] Salvaged interrupted run from ${file}`);
    } catch (err) {
      log.warn(`[Arbi] Failed to salvage ${file}:`, normalizeErrorMessage(err));
    }
  }
}

export function initArbiTracker(): void {
  _loadIndex();
  _salvageStalePartials();
  _initialized = true;
  log.info(`[Arbi] Tracker ready: ${_runs.length} run(s) loaded from index`);
}

export function getRuns(): ArbiRunRecord[] {
  return _runs;
}

export function getDiskUsageBytes(): number {
  let total = 0;
  try {
    for (const f of fs.readdirSync(_logsDir())) {
      if (!f.endsWith(".log.gz")) continue;
      try {
        total += fs.statSync(path.join(_logsDir(), f)).size;
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export function setRunVitus(id: string, vitus: number | null): ArbiRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  run.vitusActual = vitus;
  _saveIndex();
  return run;
}

export function setRunTags(id: string, tags: string[]): ArbiRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const clean = normalizeArbiTags(tags);
  if (clean.length > 0) run.tags = clean;
  else delete run.tags;
  _saveIndex();
  return run;
}

export function deleteRunLog(id: string): ArbiRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const logPath = _storedLogPath(run);
  if (logPath) {
    try {
      fs.unlinkSync(logPath);
    } catch (err) {
      log.warn("[Arbi] Failed to delete run log:", normalizeErrorMessage(err));
    }
    run.logFile = null;
    run.logSizeBytes = 0;
    _saveIndex();
  }
  return run;
}

export function deleteRun(id: string): boolean {
  const idx = _runs.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  const run = _runs[idx];
  const logPath = _storedLogPath(run);
  if (logPath) {
    try {
      fs.unlinkSync(logPath);
    } catch {
      // already gone
    }
  }
  _runs.splice(idx, 1);
  _saveIndex();
  return true;
}

/**
 * Persist a run extracted from an external EE.log. Returns null (skip) when a
 * run with the same wall-clock id already exists - re-importing is a no-op.
 */
export function addImportedRun(
  parsed: ArbiParsedRun,
  startedAt: number,
  rawSegment: string,
  endReason: ArbiRunEndReason = "imported",
): ArbiRunRecord | null {
  const id = _formatRunId(new Date(startedAt));
  if (_runs.some((r) => r.id === id) || _reservedIds.has(id)) return null;
  _reservedIds.add(id);

  let size = 0;
  try {
    fs.mkdirSync(_logsDir(), { recursive: true });
    fs.writeFileSync(_gzPath(id), zlib.gzipSync(rawSegment));
    size = fs.statSync(_gzPath(id)).size;
  } catch (err) {
    log.warn("[Arbi] Failed to write imported run gz:", normalizeErrorMessage(err));
  }
  const record = _buildRecord({ id, startedAt }, parsed, endReason, size);
  record.source = "imported";
  _addRecord(record);
  return record;
}

/** Absolute path of a run's gz capture, or null when unavailable. */
export function getRunLogPath(id: string): string | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const logPath = _storedLogPath(run);
  return logPath && fs.existsSync(logPath) ? logPath : null;
}

/** Test hook: reset module state. */
export function __resetArbiTrackerForTest(): void {
  _stopInactivityTimer();
  _parser = null;
  _active = null;
  _runs = [];
  _reservedIds.clear();
  _callbacks = { onRunSaved: null };
  _initialized = false;
  _trackingEnabled = true;
}
