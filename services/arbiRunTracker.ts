import fs from "node:fs";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { withScope } from "./logger";
import { createRunTracker } from "./runTracker";
import { createArbiParser } from "./arbiRunParser";
import type { ArbiParsedRun } from "./arbiRunParser";
import type { ArbiRunEndReason, ArbiRunRecord } from "../config/shared/arbiTypes";
import { ARBI_SPAWN_DATA_VERSION } from "../config/shared/arbiTypes";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("arbiRunTracker");

/** Same floor the summary overlay uses - shorter runs aren't worth an entry. */
const MIN_SAVED_ROTATIONS = 2;
/** Stored logs re-read per launch for cadence intervals; the rest wait for the
 * next start rather than holding a large index's startup. */
const MAX_CADENCE_BACKFILL = 200;

const tracker = createRunTracker<ArbiParsedRun, ArbiRunEndReason, ArbiRunRecord>({
  log,
  label: "[Arbi]",
  indexFile: "arbi-runs.json",
  logsDir: "arbi-logs",
  createParser: createArbiParser,
  skipReason(parsed) {
    if (!parsed.hostTelemetry) return "client-side run, no AI data in the log";
    if (parsed.rotations < MIN_SAVED_ROTATIONS) return `${parsed.rotations} rotation(s)`;
    return null;
  },
  isRecord: () => true,
  buildRecord(run, parsed, endReason, logSizeBytes) {
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
      players: parsed.players,
    };
  },
  describe: (record) =>
    `${record.node} (${record.missionType}), ` +
    `${record.rotations} rotations, ${record.drones} drones, end=${record.endReason}`,
  sameTarget: (a, b) => a.node === b.node,
  // Full stats beat none.
  richness: (record) => (record.stats !== null ? 1 : 0),
  adoptAnnotations(winner, loser) {
    if (winner.vitusActual === null && loser.vitusActual !== null) {
      winner.vitusActual = loser.vitusActual;
    }
  },
});

export const processArbiLine = tracker.processLine;
export const setArbiTrackingEnabled = tracker.setTrackingEnabled;
export const notifyEeLogReset = tracker.notifyEeLogReset;
export const shutdownArbiTracker = tracker.shutdown;
export const setArbiCallbacks = tracker.setCallbacks;
export const getRuns = tracker.getRuns;
export const awaitPendingArbiSaves = tracker.awaitPendingSaves;
export const getDiskUsageBytes = tracker.getDiskUsageBytes;
export const setRunTags = tracker.setRunTags;
export const setRunNotes = tracker.setRunNotes;
export const deleteRunLog = tracker.deleteRunLog;
export const deleteRun = tracker.deleteRun;
export const addImportedRunFromFile = tracker.addImportedRunFromFile;
export const getRunLogPath = tracker.getRunLogPath;

export function setRunVitus(id: string, vitus: number | null): ArbiRunRecord | null {
  return tracker.updateRun(id, (run) => {
    run.vitusActual = vitus;
  });
}

const _gunzip = promisify(zlib.gunzip);
let _backfillPromise: Promise<void> = Promise.resolve();

/** A record can name a log that is no longer on disk (manual cleanup, a moved
 * userData). Those runs can never be re-read, so they must not take a slot. */
function _hasStoredLog(run: ArbiRunRecord): boolean {
  return tracker.getRunLogPath(run.id) !== null;
}

async function _reparseStoredLog(run: ArbiRunRecord): Promise<ArbiParsedRun | null> {
  const logPath = tracker.getRunLogPath(run.id);
  if (!logPath) return null;
  const content = (await _gunzip(await fs.promises.readFile(logPath))).toString("utf-8");
  const parser = createArbiParser();
  for (const line of content.split(/\r?\n/)) parser.feedLine(line);
  return parser.finalize();
}

/** Records saved before squad parsing existed re-read their stored log once.
 * Only players are taken, so newer parser heuristics cannot rewrite old stats. */
async function _backfillPlayers(): Promise<void> {
  const pending = tracker.getRuns().filter((r) => r.players === undefined);
  if (pending.length === 0) return;
  let found = 0;
  for (const run of pending) {
    // [] marks the record processed even when the log is gone or unreadable.
    run.players = [];
    try {
      const players = (await _reparseStoredLog(run))?.players ?? [];
      if (players.length > 0) {
        run.players = players;
        found++;
      }
    } catch (err) {
      log.warn(`[Arbi] Squad backfill failed for ${run.id}:`, normalizeErrorMessage(err));
    }
  }
  tracker.saveIndex();
  log.info(`[Arbi] Squad names backfilled for ${found} of ${pending.length} stored run(s)`);
}

/** Records saved before cadence and spawn tracking re-read their stored log once.
 * Only the intervals, saturation shares, spawn points and waves are copied over,
 * so no other stat can drift. Runs whose log is gone keep none of it, which is
 * what hides their timeline. */
async function _backfillCadence(): Promise<void> {
  // A persisted record can be missing either field entirely; the index load only
  // validates the id, so neither `stats` nor `logFile` is guaranteed present.
  // Spawn points from an older parser are re-read too, for their per-wave counts.
  const pending = tracker
    .getRuns()
    .filter(
      (r) =>
        !!r.stats &&
        (r.stats.pauseIntervals === undefined ||
          r.stats.rotationSaturationPct === undefined ||
          ((r.stats.spawnPoints?.length ?? 0) > 0 &&
            r.stats.spawnDataVersion !== ARBI_SPAWN_DATA_VERSION)) &&
        _hasStoredLog(r),
    );
  if (pending.length === 0) return;
  let filled = 0;
  // Newest first (the index order), so the runs a user is likely to open land
  // first; a bigger index finishes over the next few launches.
  for (const run of pending.slice(0, MAX_CADENCE_BACKFILL)) {
    const stats = run.stats;
    if (!stats) continue;
    try {
      const reparsed = (await _reparseStoredLog(run))?.stats;
      if (!reparsed?.pauseIntervals) continue;
      stats.pauseIntervals = reparsed.pauseIntervals;
      stats.idleIntervals = reparsed.idleIntervals ?? [];
      stats.rotationSaturationPct = reparsed.rotationSaturationPct ?? [];
      stats.spawnPoints = reparsed.spawnPoints ?? [];
      stats.spawnDataVersion = ARBI_SPAWN_DATA_VERSION;
      // A different wave count means the parser now reads the log differently;
      // keep the stored waves rather than silently reshaping the clear map.
      if (reparsed.waves && stats.waves && reparsed.waves.length === stats.waves.length) {
        stats.waves = reparsed.waves;
      }
      filled++;
    } catch (err) {
      log.warn(`[Arbi] Cadence backfill failed for ${run.id}:`, normalizeErrorMessage(err));
    }
  }
  if (filled > 0) tracker.saveIndex();
  log.info(
    `[Arbi] Cadence, spawn data and spawn waves backfilled for ${filled} of ${pending.length} stored run(s)`,
  );
}

export function initArbiTracker(): void {
  tracker.init();
  // One chain: each gunzip awaits, so startup keeps its event loop either way.
  // Nothing awaits this at startup, so a throw here must not escape as an
  // unhandled rejection and take the main process down.
  _backfillPromise = _backfillPlayers()
    .then(_backfillCadence)
    .catch((err) => log.warn("[Arbi] Backfill pass failed:", normalizeErrorMessage(err)));
}

/** Test hook: reset module state. */
export function __resetArbiTrackerForTest(): void {
  tracker.resetForTest();
  _backfillPromise = Promise.resolve();
}

/** Test hook: the squad backfill kicked off by init. */
export function __arbiBackfillForTest(): Promise<void> {
  return _backfillPromise;
}
