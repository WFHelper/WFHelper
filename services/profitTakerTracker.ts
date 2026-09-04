import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import { createProfitTakerParser } from "./profitTakerParser";
import type { PtParsedRun, PtParser } from "./profitTakerParser";
import type { PtRunEndReason, PtRunRecord } from "../config/shared/profitTakerTypes";
import { normalizePtNotes, normalizePtTags } from "../config/shared/profitTakerTypes";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("profitTakerTracker");

const INDEX_SCHEMA_VERSION = 1;
/** Flush the capture buffer to the partial file every N lines (crash-safety vs syscall spam). */
const FLUSH_EVERY_LINES = 200;
/** Fallback for ends the markers miss (crash to desktop, connection loss). */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const INACTIVITY_CHECK_MS = 60_000;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
/** Windows within which a live capture and an imported log describe one run.
 * Wall-clock start can drift by the import's header anchor; the duration cannot. */
const DUPLICATE_START_TOLERANCE_MS = 120_000;
const DUPLICATE_DURATION_TOLERANCE_SEC = 5;

/** Why a parsed run should not be indexed, or null when it should be. */
function _skipReason(parsed: PtParsedRun): string | null {
  if (!parsed.confirmed) return "bounty was never entered";
  if (!parsed.hostTelemetry) return "client-side run, no Camper telemetry in the log";
  if (parsed.phases.length === 0) return "no phase data";
  return null;
}

interface ActiveRun {
  id: string;
  startedAt: number;
  /** Game time of the line that opened the capture; anchors the record's wall clock. */
  capturedAtSec: number;
  partialPath: string;
  pendingLines: string[];
  lastCombatAt: number;
  lastActivityCount: number;
}

interface PtCallbacks {
  onRunSaved: ((run: PtRunRecord) => void) | null;
}

let _parser: PtParser | null = null;
let _active: ActiveRun | null = null;
let _runs: PtRunRecord[] = [];
/** Ids reserved before their record lands in _runs (gzip in flight). */
const _reservedIds = new Set<string>();
let _callbacks: PtCallbacks = { onRunSaved: null };
let _inactivityTimer: ReturnType<typeof setInterval> | null = null;
let _initialized = false;
let _trackingEnabled = true;
/** In-flight finalizations; a refresh waits on these so it never returns a stale index. */
const _pendingSaves = new Set<Promise<void>>();

function _indexPath(): string {
  return userDataPath("pt-runs.json");
}

function _logsDir(): string {
  return userDataPath("pt-logs");
}

function _gzPath(id: string): string {
  return path.join(_logsDir(), `${id}.log.gz`);
}

function _storedLogPath(run: Pick<PtRunRecord, "id" | "logFile">): string | null {
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
    log.warn("[PT] Failed to save run index:", normalizeErrorMessage(err));
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
        (r): r is PtRunRecord =>
          !!r &&
          typeof r === "object" &&
          typeof (r as { id?: unknown }).id === "string" &&
          RUN_ID_RE.test((r as { id: string }).id) &&
          Array.isArray((r as { phases?: unknown }).phases),
      )
      .map((run) =>
        run.logFile == null || _storedLogPath(run)
          ? run
          : { ...run, logFile: null, logSizeBytes: 0 },
      );
  } catch (err) {
    log.warn("[PT] Failed to load run index:", normalizeErrorMessage(err));
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
    log.warn("[PT] Failed to append capture lines:", normalizeErrorMessage(err));
  }
  run.pendingLines = [];
}

function _buildRecord(
  run: { id: string; startedAt: number },
  parsed: PtParsedRun,
  endReason: PtRunEndReason,
  logSizeBytes: number,
): PtRunRecord {
  const endSec = parsed.runEndSec ?? parsed.lastActivitySec;
  const gameElapsedMs = Math.max(0, (endSec - parsed.runStartSec) * 1000);
  return {
    id: run.id,
    startedAt: run.startedAt,
    endedAt: run.startedAt + gameElapsedMs,
    durationSec: parsed.durationSec,
    flightSec: parsed.flightSec,
    shieldSec: parsed.shieldSec,
    legSec: parsed.legSec,
    bodySec: parsed.bodySec,
    pylonSec: parsed.pylonSec,
    phases: parsed.phases,
    players: parsed.players,
    solo: parsed.players.length <= 1,
    complete: parsed.complete,
    bugged: parsed.bugged,
    aborted: parsed.aborted,
    ...(parsed.hostMigration ? { hostMigration: true as const } : {}),
    ...(parsed.flightUnreliable ? { flightUnreliable: true as const } : {}),
    logFile: logSizeBytes > 0 ? `${run.id}.log.gz` : null,
    logSizeBytes,
    endReason,
    source: "live",
  };
}

function _sameRun(a: PtRunRecord, b: PtRunRecord): boolean {
  return (
    Math.abs(a.startedAt - b.startedAt) <= DUPLICATE_START_TOLERANCE_MS &&
    Math.abs(a.durationSec - b.durationSec) <= DUPLICATE_DURATION_TOLERANCE_SEC
  );
}

/** Richer record first: the longer raw log, then live. */
function _richerFirst(a: PtRunRecord, b: PtRunRecord): [PtRunRecord, PtRunRecord] {
  if (a.logSizeBytes !== b.logSizeBytes) return a.logSizeBytes > b.logSizeBytes ? [a, b] : [b, a];
  return a.source === "live" ? [a, b] : [b, a];
}

/** Recompute every duplicateOf link from scratch; returns true when anything moved.
 * Only cross-source pairs qualify, so two genuine back-to-back runs stay separate. */
function _markDuplicates(): boolean {
  const winners = new Map<string, string>();
  for (let i = 0; i < _runs.length; i++) {
    for (let j = i + 1; j < _runs.length; j++) {
      const a = _runs[i];
      const b = _runs[j];
      if (a.source === b.source || !_sameRun(a, b)) continue;
      const [winner, loser] = _richerFirst(a, b);
      if (!winners.has(loser.id)) winners.set(loser.id, winner.id);
    }
  }
  const resolve = (id: string, depth = 0): string => {
    const next = winners.get(id);
    return next === undefined || depth >= 4 ? id : resolve(next, depth + 1);
  };
  let changed = false;
  for (const run of _runs) {
    const raw = winners.get(run.id);
    const target = raw === undefined ? undefined : resolve(raw);
    if (target === run.duplicateOf) continue;
    if (target === undefined || target === run.id) delete run.duplicateOf;
    else run.duplicateOf = target;
    changed = true;
  }
  return changed;
}

function _addRecord(record: PtRunRecord): void {
  _runs.unshift(record);
  _markDuplicates();
  _saveIndex();
  log.info(
    `[PT] Run saved: ${record.durationSec.toFixed(3)}s, ${record.phases.length} phase(s), ` +
      `complete=${record.complete}, bugged=${record.bugged}, end=${record.endReason}`,
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
      log.info("[PT] No fight events for 10min - finalizing");
      _finalizeRun("inactivity", false);
    }
  }, INACTIVITY_CHECK_MS);
  if (typeof _inactivityTimer.unref === "function") _inactivityTimer.unref();
}

/** Wall clock of the flight start, from the capture anchor and the game clock. */
function _startedAtFor(run: ActiveRun, parsed: PtParsedRun): number {
  return run.startedAt + (parsed.runStartSec - run.capturedAtSec) * 1000;
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
        log.warn("[PT] gzip of run capture failed:", normalizeErrorMessage(err));
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

function _finalizeRun(endReason: PtRunEndReason, sync: boolean): void {
  if (!_active || !_parser) return;
  const run = _active;
  _active = null;
  _stopInactivityTimer();

  const parsed = _parser.finalize();
  if (!parsed) {
    _reservedIds.delete(run.id);
    return;
  }

  const skip = _skipReason(parsed);
  if (skip) {
    _reservedIds.delete(run.id);
    try {
      fs.unlinkSync(run.partialPath);
    } catch {
      // nothing flushed yet -> no file
    }
    log.info(`[PT] Run not saved (${skip})`);
    return;
  }

  _flushPending(run);
  const startedAt = _startedAtFor(run, parsed);

  if (sync) {
    // App-quit path: no event loop left for streams.
    let size = 0;
    try {
      fs.writeFileSync(_gzPath(run.id), zlib.gzipSync(fs.readFileSync(run.partialPath)));
      fs.unlinkSync(run.partialPath);
      size = fs.statSync(_gzPath(run.id)).size;
    } catch (err) {
      log.warn("[PT] sync gzip failed:", normalizeErrorMessage(err));
    }
    _addRecord(_buildRecord({ id: run.id, startedAt }, parsed, endReason, size));
    return;
  }

  const pending = new Promise<void>((resolve) => {
    _gzipPartialAsync(run.partialPath, _gzPath(run.id), (size) => {
      try {
        _addRecord(_buildRecord({ id: run.id, startedAt }, parsed, endReason, size));
      } catch (err) {
        // The index write already happened; a throwing onRunSaved must not strand
        // this promise in _pendingSaves and kill Refresh for the session.
        log.warn("[PT] Run-saved notification failed:", normalizeErrorMessage(err));
      } finally {
        resolve();
      }
    });
  });
  _pendingSaves.add(pending);
  void pending.finally(() => _pendingSaves.delete(pending));
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
    capturedAtSec: gameTimeSec,
    partialPath: path.join(_logsDir(), `${id}.partial.log`),
    pendingLines: [firstLine],
    lastCombatAt: Date.now(),
    lastActivityCount: 0,
  };
  _startInactivityTimer();
  log.info(`[PT] Run capture started: ${id}`);
}

export function processProfitTakerLine(line: string, source: "dbwin" | "file"): void {
  // File-poll lines are complete, ordered and deduped; dbwin duplicates them.
  if (!_trackingEnabled || source !== "file" || !_initialized) return;
  if (!_parser) _parser = createProfitTakerParser();

  const event = _parser.feedLine(line);

  if (event?.type === "run-start") {
    _startCapture(event.gameTimeSec, line);
    return;
  }

  if (event?.type === "run-end") {
    _finalizeRun(event.reason, false);
    // Back-to-back runs: the ending line may itself start the next one.
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
  log.info(`[PT] Run capture discarded: ${run.id}`);
}

/** Full opt-out: ignore EE.log lines and drop any in-progress capture. */
export function setPtTrackingEnabled(enabled: boolean): void {
  if (_trackingEnabled === enabled) return;
  _trackingEnabled = enabled;
  log.info(`[PT] Run tracking ${enabled ? "enabled" : "disabled"}`);
  if (!enabled) _discardActiveRun();
}

/** EE.log was truncated or unlinked (game restart) - finalize with what we have. */
export function notifyPtEeLogReset(): void {
  if (_active) {
    log.info("[PT] EE.log reset mid-run - finalizing");
    _finalizeRun("log-truncated", false);
  }
}

export function shutdownPtTracker(): void {
  if (_active) _finalizeRun("app-quit", true);
  _stopInactivityTimer();
  _parser = null;
  _callbacks = { onRunSaved: null };
  _initialized = false;
}

export function setPtCallbacks(cbs: Partial<PtCallbacks>): void {
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
      const parser = createProfitTakerParser();
      let capturedAtSec: number | null = null;
      for (const line of content.split(/\r?\n/)) {
        const event = parser.feedLine(line);
        if (event?.type === "run-start" && capturedAtSec === null)
          capturedAtSec = event.gameTimeSec;
      }
      const parsed = parser.finalize();
      if (!parsed || _skipReason(parsed)) {
        fs.unlinkSync(partialPath);
        continue;
      }
      const mtime = fs.statSync(partialPath).mtimeMs;
      const endSec = parsed.runEndSec ?? parsed.lastActivitySec;
      const startedAt = mtime - Math.max(0, endSec - parsed.runStartSec) * 1000;
      const id = _uniqueRunId(new Date(startedAt));
      fs.writeFileSync(_gzPath(id), zlib.gzipSync(content));
      fs.unlinkSync(partialPath);
      const size = fs.statSync(_gzPath(id)).size;
      _addRecord(_buildRecord({ id, startedAt }, parsed, "log-truncated", size));
      _reservedIds.delete(id);
      log.info(`[PT] Salvaged interrupted run from ${file}`);
    } catch (err) {
      log.warn(`[PT] Failed to salvage ${file}:`, normalizeErrorMessage(err));
    }
  }
}

export function initPtTracker(): void {
  _loadIndex();
  if (_markDuplicates()) _saveIndex();
  _salvageStalePartials();
  _initialized = true;
  log.info(`[PT] Tracker ready: ${_runs.length} run(s) loaded from index`);
}

export function getPtRuns(): PtRunRecord[] {
  return _runs;
}

/** Resolve once every in-flight gzip and index write has landed. */
export async function awaitPendingPtSaves(): Promise<void> {
  // Loop, not a single Promise.all: the 500ms EE.log poll can finalize another
  // run while we await, adding to the set after the snapshot was taken.
  while (_pendingSaves.size > 0) await Promise.all([..._pendingSaves]);
}

export function getPtDiskUsageBytes(): number {
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

export function setPtRunTags(id: string, tags: string[]): PtRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const clean = normalizePtTags(tags);
  if (clean.length > 0) run.tags = clean;
  else delete run.tags;
  _saveIndex();
  return run;
}

export function setPtRunNotes(id: string, notes: string): PtRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const clean = normalizePtNotes(notes);
  if (clean) run.notes = clean;
  else delete run.notes;
  _saveIndex();
  return run;
}

export function deletePtRunLog(id: string): PtRunRecord | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const logPath = _storedLogPath(run);
  if (logPath) {
    try {
      fs.unlinkSync(logPath);
    } catch (err) {
      log.warn("[PT] Failed to delete run log:", normalizeErrorMessage(err));
    }
    run.logFile = null;
    run.logSizeBytes = 0;
    _saveIndex();
  }
  return run;
}

export function deletePtRun(id: string): boolean {
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
  // Deleting the richer record must release the copy that pointed at it.
  _markDuplicates();
  _saveIndex();
  return true;
}

export async function addImportedPtRunFromFile(
  parsed: PtParsedRun,
  startedAt: number,
  segmentPath: string,
  endReason: PtRunEndReason = "imported",
): Promise<PtRunRecord | null> {
  const removeSegment = async (): Promise<void> => {
    try {
      await fs.promises.unlink(segmentPath);
    } catch {
      // The importer may already have removed the segment.
    }
  };

  if (_skipReason(parsed)) {
    await removeSegment();
    return null;
  }
  const id = _formatRunId(new Date(startedAt));
  if (_runs.some((r) => r.id === id) || _reservedIds.has(id)) {
    await removeSegment();
    return null;
  }
  _reservedIds.add(id);

  let size = 0;
  try {
    await fs.promises.mkdir(_logsDir(), { recursive: true });
    await pipelinePromise(
      fs.createReadStream(segmentPath),
      zlib.createGzip(),
      fs.createWriteStream(_gzPath(id)),
    );
    size = (await fs.promises.stat(_gzPath(id))).size;
  } catch (err) {
    log.warn("[PT] Failed to write imported run gz:", normalizeErrorMessage(err));
    try {
      await fs.promises.unlink(_gzPath(id));
    } catch {
      // The output may not have been created.
    }
  } finally {
    await removeSegment();
  }
  const record = _buildRecord({ id, startedAt }, parsed, endReason, size);
  record.source = "imported";
  try {
    _addRecord(record);
    return record;
  } finally {
    _reservedIds.delete(id);
  }
}

/** Absolute path of a run's gz capture, or null when unavailable. */
export function getPtRunLogPath(id: string): string | null {
  const run = _runs.find((r) => r.id === id);
  if (!run) return null;
  const logPath = _storedLogPath(run);
  return logPath && fs.existsSync(logPath) ? logPath : null;
}

/** Test hook: reset module state. */
export function __resetPtTrackerForTest(): void {
  _stopInactivityTimer();
  _parser = null;
  _active = null;
  _runs = [];
  _reservedIds.clear();
  _pendingSaves.clear();
  _callbacks = { onRunSaved: null };
  _initialized = false;
  _trackingEnabled = true;
}
