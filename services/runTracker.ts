import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
import type { ScopedLogger } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import { normalizeRunNotes, normalizeRunTags } from "./runAnnotations";
import { normalizeErrorMessage } from "../config/shared/errors";

const INDEX_SCHEMA_VERSION = 1;
/** Flush the capture buffer to the partial file every N lines (crash-safety vs syscall spam). */
const FLUSH_EVERY_LINES = 200;
/** Finalize a run when no activity events arrive for this long - fallback for
 * ends the parser markers miss (e.g. crash to desktop, connection loss). */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const INACTIVITY_CHECK_MS = 60_000;
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/;
/** Windows within which a live capture and an imported log describe one run.
 * Wall-clock start can drift by the import's header anchor; the duration cannot. */
const DUPLICATE_START_TOLERANCE_MS = 120_000;
const DUPLICATE_DURATION_TOLERANCE_SEC = 5;

/** End reasons the tracker itself produces; a feature's union adds its own. */
type RunReason<TReason> = TReason | "log-truncated" | "app-quit" | "inactivity" | "imported";

/** What every EE.log run parser exposes to the capture machinery. */
interface RunParser<TParsed, TReason> {
  feedLine(
    line: string,
  ):
    | { type: "run-start"; gameTimeSec: number }
    | { type: "run-end"; reason: RunReason<TReason> }
    | null;
  /** Monotonic activity count; lines that do not bump it cannot keep a run alive. */
  activityCount(): number;
  finalize(): TParsed | null;
}

/** The game-clock fields every parsed run carries; the rest is per feature. */
interface ParsedRunTiming {
  runStartSec: number;
  /** Timestamp of the end marker that closed the run; null when it ended implicitly. */
  runEndSec: number | null;
  lastActivitySec: number;
}

/** The index fields the tracker itself reads and writes; the rest is per feature. */
interface RunRecordBase {
  /** "YYYY-MM-DD_HH-mm-ss" wall clock at run start; also the .log.gz basename. */
  id: string;
  startedAt: number;
  durationSec: number;
  logFile: string | null;
  logSizeBytes: number;
  source: "live" | "imported";
  tags?: string[];
  notes?: string;
  /** Id of the richer record this one duplicates; absent when the run is unique. */
  duplicateOf?: string;
}

interface RunTrackerSpec<TParsed extends ParsedRunTiming, TReason, TRecord> {
  log: ScopedLogger;
  /** Log prefix, e.g. "[Arbi]". */
  label: string;
  /** Index file and log directory under userData, e.g. "arbi-runs.json" / "arbi-logs". */
  indexFile: string;
  logsDir: string;
  createParser(): RunParser<TParsed, TReason>;
  /** Why a parsed run should not be indexed, or null when it should be. */
  skipReason(parsed: TParsed): string | null;
  /** True when a persisted index entry has the shape the feature needs; the
   * tracker has already checked the id. */
  isRecord(raw: object): boolean;
  buildRecord(
    run: { id: string; startedAt: number },
    parsed: TParsed,
    endReason: RunReason<TReason>,
    logSizeBytes: number,
  ): TRecord;
  /** One-line summary for the "Run saved" log entry. */
  describe(record: TRecord): string;
  /** Extra condition for two records to be the same run; the tracker already
   * compares start time and duration. */
  sameTarget(a: TRecord, b: TRecord): boolean;
  /** Higher wins the duplicate contest before log size and source are compared. */
  richness(record: TRecord): number;
  /** Carry feature-specific annotations from a newly demoted duplicate onto its winner. */
  adoptAnnotations?(winner: TRecord, loser: TRecord): void;
}

interface ActiveRun {
  id: string;
  startedAt: number;
  /** Game time of the line that opened the capture; anchors the record's wall clock. */
  capturedAtSec: number;
  partialPath: string;
  pendingLines: string[];
  /** Wall clock of the last activity event (not last log line - the orbiter keeps
   * logging after a mission, which must not keep the run alive). */
  lastCombatAt: number;
  lastActivityCount: number;
}

interface RunTracker<TParsed, TReason, TRecord> {
  init(): void;
  processLine(line: string, source: "dbwin" | "file"): void;
  /** Full opt-out: ignore EE.log lines and drop any in-progress capture. */
  setTrackingEnabled(enabled: boolean): void;
  /** EE.log was truncated or unlinked (game restart) - finalize with what we have. */
  notifyEeLogReset(): void;
  shutdown(): void;
  setCallbacks(cbs: Partial<{ onRunSaved: ((run: TRecord) => void) | null }>): void;
  getRuns(): TRecord[];
  /** Resolve once every in-flight gzip and index write has landed. */
  awaitPendingSaves(): Promise<void>;
  getDiskUsageBytes(): number;
  /** Mutate one record in place and persist the index; null when the id is unknown. */
  updateRun(id: string, mutate: (run: TRecord) => void): TRecord | null;
  setRunTags(id: string, tags: string[]): TRecord | null;
  setRunNotes(id: string, notes: string): TRecord | null;
  deleteRunLog(id: string): TRecord | null;
  deleteRun(id: string): boolean;
  addImportedRunFromFile(
    parsed: TParsed,
    startedAt: number,
    segmentPath: string,
    endReason?: RunReason<TReason>,
  ): Promise<TRecord | null>;
  /** Absolute path of a run's gz capture, or null when unavailable. */
  getRunLogPath(id: string): string | null;
  saveIndex(): void;
  resetForTest(): void;
}

/** Builds the capture/gzip/index/duplicate machinery shared by every EE.log run
 * tracker; the feature supplies its parser, record shape and file names. */
export function createRunTracker<
  TParsed extends ParsedRunTiming,
  TReason extends string,
  TRecord extends RunRecordBase,
>(spec: RunTrackerSpec<TParsed, TReason, TRecord>): RunTracker<TParsed, TReason, TRecord> {
  const { log, label: L } = spec;

  let _parser: RunParser<TParsed, TReason> | null = null;
  let _active: ActiveRun | null = null;
  let _runs: TRecord[] = [];
  /** Ids reserved before their record lands in _runs (gzip in flight); prevents
   * back-to-back runs in the same wall-clock second from sharing capture files. */
  const _reservedIds = new Set<string>();
  let _onRunSaved: ((run: TRecord) => void) | null = null;
  let _inactivityTimer: ReturnType<typeof setInterval> | null = null;
  let _initialized = false;
  let _trackingEnabled = true;
  /** In-flight finalizations; a refresh waits on these so it never returns a stale index. */
  const _pendingSaves = new Set<Promise<void>>();

  const _indexPath = (): string => userDataPath(spec.indexFile);
  const _logsDir = (): string => userDataPath(spec.logsDir);
  const _gzPath = (id: string): string => path.join(_logsDir(), `${id}.log.gz`);

  function _storedLogPath(run: Pick<RunRecordBase, "id" | "logFile">): string | null {
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
      log.warn(`${L} Failed to save run index:`, normalizeErrorMessage(err));
    }
  }

  /** The index is a plain file a user can edit; only the write path normalises,
   * so a hand-written note or tag list has to be cleaned on the way in too. */
  function _normalizeAnnotations(run: TRecord): TRecord {
    const tags = normalizeRunTags(run.tags);
    if (tags.length > 0) run.tags = tags;
    else delete run.tags;
    const notes = normalizeRunNotes(run.notes);
    if (notes) run.notes = notes;
    else delete run.notes;
    return run;
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
          (r): r is TRecord =>
            !!r &&
            typeof r === "object" &&
            typeof (r as { id?: unknown }).id === "string" &&
            RUN_ID_RE.test((r as { id: string }).id) &&
            spec.isRecord(r),
        )
        .map((run) =>
          _normalizeAnnotations(
            run.logFile == null || _storedLogPath(run)
              ? run
              : { ...run, logFile: null, logSizeBytes: 0 },
          ),
        );
    } catch (err) {
      log.warn(`${L} Failed to load run index:`, normalizeErrorMessage(err));
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
      log.warn(`${L} Failed to append capture lines:`, normalizeErrorMessage(err));
    }
    run.pendingLines = [];
  }

  function _sameRun(a: TRecord, b: TRecord): boolean {
    return (
      Math.abs(a.startedAt - b.startedAt) <= DUPLICATE_START_TOLERANCE_MS &&
      Math.abs(a.durationSec - b.durationSec) <= DUPLICATE_DURATION_TOLERANCE_SEC &&
      spec.sameTarget(a, b)
    );
  }

  /** Richer record first: the feature's richness, then the longer raw log, then live. */
  function _richerFirst(a: TRecord, b: TRecord): [TRecord, TRecord] {
    const rich = spec.richness(a) - spec.richness(b);
    if (rich !== 0) return rich > 0 ? [a, b] : [b, a];
    if (a.logSizeBytes !== b.logSizeBytes) return a.logSizeBytes > b.logSizeBytes ? [a, b] : [b, a];
    return a.source === "live" ? [a, b] : [b, a];
  }

  /** A demoted record's annotations move onto the winner the list will show
   * instead, unless the winner already carries its own. */
  function _adoptAnnotations(winner: TRecord, loser: TRecord): void {
    if (winner.notes === undefined && loser.notes !== undefined) winner.notes = loser.notes;
    if (winner.tags === undefined && loser.tags !== undefined) winner.tags = [...loser.tags];
    spec.adoptAnnotations?.(winner, loser);
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
      else {
        run.duplicateOf = target;
        const winner = _runs.find((r) => r.id === target);
        if (winner) _adoptAnnotations(winner, run);
      }
      changed = true;
    }
    return changed;
  }

  function _addRecord(record: TRecord): void {
    _runs.unshift(record);
    _markDuplicates();
    _saveIndex();
    log.info(`${L} Run saved: ${spec.describe(record)}`);
    if (_onRunSaved) _onRunSaved(record);
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
        log.info(`${L} No activity events for 10min - finalizing`);
        _finalizeRun("inactivity", false);
      }
    }, INACTIVITY_CHECK_MS);
    if (typeof _inactivityTimer.unref === "function") _inactivityTimer.unref();
  }

  /** Wall clock of the parsed start, from the capture anchor and the game clock. */
  function _startedAtFor(run: ActiveRun, parsed: TParsed): number {
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
          log.warn(`${L} gzip of run capture failed:`, normalizeErrorMessage(err));
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

  function _finalizeRun(endReason: RunReason<TReason>, sync: boolean): void {
    if (!_active || !_parser) return;
    const run = _active;
    _active = null;
    _stopInactivityTimer();

    const parsed = _parser.finalize();
    if (!parsed) {
      _reservedIds.delete(run.id);
      return;
    }

    const skip = spec.skipReason(parsed);
    if (skip) {
      _reservedIds.delete(run.id);
      try {
        fs.unlinkSync(run.partialPath);
      } catch {
        // nothing flushed yet -> no file
      }
      log.info(`${L} Run not saved (${skip})`);
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
        log.warn(`${L} sync gzip failed:`, normalizeErrorMessage(err));
      }
      _addRecord(spec.buildRecord({ id: run.id, startedAt }, parsed, endReason, size));
      return;
    }

    const pending = new Promise<void>((resolve) => {
      _gzipPartialAsync(run.partialPath, _gzPath(run.id), (size) => {
        try {
          _addRecord(spec.buildRecord({ id: run.id, startedAt }, parsed, endReason, size));
        } catch (err) {
          // The index write already happened; a throwing onRunSaved must not strand
          // this promise in _pendingSaves and kill Refresh for the session.
          log.warn(`${L} Run-saved notification failed:`, normalizeErrorMessage(err));
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
    log.info(`${L} Run capture started: ${id}`);
  }

  function processLine(line: string, source: "dbwin" | "file"): void {
    // File-poll lines are complete, ordered and deduped; dbwin duplicates them.
    if (!_trackingEnabled || source !== "file" || !_initialized) return;
    if (!_parser) _parser = spec.createParser();

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
    log.info(`${L} Run capture discarded: ${run.id}`);
  }

  function setTrackingEnabled(enabled: boolean): void {
    if (_trackingEnabled === enabled) return;
    _trackingEnabled = enabled;
    log.info(`${L} Run tracking ${enabled ? "enabled" : "disabled"}`);
    if (!enabled) _discardActiveRun();
  }

  function notifyEeLogReset(): void {
    if (_active) {
      log.info(`${L} EE.log reset mid-run - finalizing`);
      _finalizeRun("log-truncated", false);
    }
  }

  function shutdown(): void {
    if (_active) _finalizeRun("app-quit", true);
    _stopInactivityTimer();
    _parser = null;
    _onRunSaved = null;
    _initialized = false;
  }

  function setCallbacks(cbs: Partial<{ onRunSaved: ((run: TRecord) => void) | null }>): void {
    if ("onRunSaved" in cbs) _onRunSaved = cbs.onRunSaved ?? null;
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
        const parser = spec.createParser();
        for (const line of content.split(/\r?\n/)) parser.feedLine(line);
        const parsed = parser.finalize();
        if (!parsed || spec.skipReason(parsed)) {
          fs.unlinkSync(partialPath);
          continue;
        }
        // The file's mtime is the last flush, so the run ended about then.
        const mtime = fs.statSync(partialPath).mtimeMs;
        const endSec = parsed.runEndSec ?? parsed.lastActivitySec;
        const startedAt = mtime - Math.max(0, endSec - parsed.runStartSec) * 1000;
        const id = _uniqueRunId(new Date(startedAt));
        fs.writeFileSync(_gzPath(id), zlib.gzipSync(content));
        fs.unlinkSync(partialPath);
        const size = fs.statSync(_gzPath(id)).size;
        _addRecord(spec.buildRecord({ id, startedAt }, parsed, "log-truncated", size));
        _reservedIds.delete(id);
        log.info(`${L} Salvaged interrupted run from ${file}`);
      } catch (err) {
        log.warn(`${L} Failed to salvage ${file}:`, normalizeErrorMessage(err));
      }
    }
  }

  function init(): void {
    _loadIndex();
    if (_markDuplicates()) _saveIndex();
    _salvageStalePartials();
    _initialized = true;
    log.info(`${L} Tracker ready: ${_runs.length} run(s) loaded from index`);
  }

  async function awaitPendingSaves(): Promise<void> {
    // Loop, not a single Promise.all: the 500ms EE.log poll can finalize another
    // run while we await, adding to the set after the snapshot was taken.
    while (_pendingSaves.size > 0) await Promise.all([..._pendingSaves]);
  }

  function getDiskUsageBytes(): number {
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

  function updateRun(id: string, mutate: (run: TRecord) => void): TRecord | null {
    const run = _runs.find((r) => r.id === id);
    if (!run) return null;
    mutate(run);
    _saveIndex();
    return run;
  }

  function setRunTags(id: string, tags: string[]): TRecord | null {
    return updateRun(id, (run) => {
      const clean = normalizeRunTags(tags);
      if (clean.length > 0) run.tags = clean;
      else delete run.tags;
    });
  }

  function setRunNotes(id: string, notes: string): TRecord | null {
    return updateRun(id, (run) => {
      const clean = normalizeRunNotes(notes);
      if (clean) run.notes = clean;
      else delete run.notes;
    });
  }

  function deleteRunLog(id: string): TRecord | null {
    const run = _runs.find((r) => r.id === id);
    if (!run) return null;
    const logPath = _storedLogPath(run);
    if (logPath) {
      try {
        fs.unlinkSync(logPath);
      } catch (err) {
        log.warn(`${L} Failed to delete run log:`, normalizeErrorMessage(err));
      }
      run.logFile = null;
      run.logSizeBytes = 0;
      _saveIndex();
    }
    return run;
  }

  function deleteRun(id: string): boolean {
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

  async function addImportedRunFromFile(
    parsed: TParsed,
    startedAt: number,
    segmentPath: string,
    endReason: RunReason<TReason> = "imported",
  ): Promise<TRecord | null> {
    const removeSegment = async (): Promise<void> => {
      try {
        await fs.promises.unlink(segmentPath);
      } catch {
        // The importer may already have removed the segment.
      }
    };

    if (spec.skipReason(parsed)) {
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
      log.warn(`${L} Failed to write imported run gz:`, normalizeErrorMessage(err));
      try {
        await fs.promises.unlink(_gzPath(id));
      } catch {
        // The output may not have been created.
      }
    } finally {
      await removeSegment();
    }
    const record = spec.buildRecord({ id, startedAt }, parsed, endReason, size);
    record.source = "imported";
    try {
      _addRecord(record);
      return record;
    } finally {
      _reservedIds.delete(id);
    }
  }

  function getRunLogPath(id: string): string | null {
    const run = _runs.find((r) => r.id === id);
    if (!run) return null;
    const logPath = _storedLogPath(run);
    return logPath && fs.existsSync(logPath) ? logPath : null;
  }

  function resetForTest(): void {
    _stopInactivityTimer();
    _parser = null;
    _active = null;
    _runs = [];
    _reservedIds.clear();
    _pendingSaves.clear();
    _onRunSaved = null;
    _initialized = false;
    _trackingEnabled = true;
  }

  return {
    init,
    processLine,
    setTrackingEnabled,
    notifyEeLogReset,
    shutdown,
    setCallbacks,
    getRuns: () => _runs,
    awaitPendingSaves,
    getDiskUsageBytes,
    updateRun,
    setRunTags,
    setRunNotes,
    deleteRunLog,
    deleteRun,
    addImportedRunFromFile,
    getRunLogPath,
    saveIndex: _saveIndex,
    resetForTest,
  };
}
