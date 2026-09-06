import { withScope } from "./logger";
import { createRunTracker } from "./runTracker";
import { createProfitTakerParser } from "./profitTakerParser";
import type { PtParsedRun } from "./profitTakerParser";
import type { PtRunEndReason, PtRunRecord } from "../config/shared/profitTakerTypes";

const tracker = createRunTracker<PtParsedRun, PtRunEndReason, PtRunRecord>({
  log: withScope("profitTakerTracker"),
  label: "[PT]",
  indexFile: "pt-runs.json",
  logsDir: "pt-logs",
  createParser: createProfitTakerParser,
  skipReason(parsed) {
    if (!parsed.confirmed) return "bounty was never entered";
    if (!parsed.hostTelemetry) return "client-side run, no Camper telemetry in the log";
    if (parsed.phases.length === 0) return "no phase data";
    return null;
  },
  isRecord: (raw) => Array.isArray((raw as { phases?: unknown }).phases),
  buildRecord(run, parsed, endReason, logSizeBytes) {
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
  },
  describe: (record) =>
    `${record.durationSec.toFixed(3)}s, ${record.phases.length} phase(s), ` +
    `complete=${record.complete}, bugged=${record.bugged}, end=${record.endReason}`,
  // There is one orb, so start time and duration alone identify a run.
  sameTarget: () => true,
  richness: () => 0,
});

export const processProfitTakerLine = tracker.processLine;
export const setPtTrackingEnabled = tracker.setTrackingEnabled;
export const notifyPtEeLogReset = tracker.notifyEeLogReset;
export const shutdownPtTracker = tracker.shutdown;
export const setPtCallbacks = tracker.setCallbacks;
export const initPtTracker = tracker.init;
export const getPtRuns = tracker.getRuns;
export const awaitPendingPtSaves = tracker.awaitPendingSaves;
export const getPtDiskUsageBytes = tracker.getDiskUsageBytes;
export const setPtRunTags = tracker.setRunTags;
export const setPtRunNotes = tracker.setRunNotes;
export const deletePtRunLog = tracker.deleteRunLog;
export const deletePtRun = tracker.deleteRun;
export const addImportedPtRunFromFile = tracker.addImportedRunFromFile;
export const getPtRunLogPath = tracker.getRunLogPath;
export const __resetPtTrackerForTest = tracker.resetForTest;
