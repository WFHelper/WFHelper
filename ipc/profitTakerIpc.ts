import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dialog, shell } from "electron";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as ptTracker from "../services/profitTakerTracker";
import { importProfitTakerLog } from "../services/profitTakerLogImporter";
import { forceEeLogPoll } from "../services/eeLogMonitor";
import type { PtImportResult, PtRunsPayload } from "../config/shared/profitTakerTypes";
import { normalizePtNotes, normalizePtTags } from "../config/shared/profitTakerTypes";
import {
  PT_GET_RUNS,
  PT_REFRESH_RUNS,
  PT_SET_TAGS,
  PT_SET_NOTES,
  PT_DELETE_RUN,
  PT_DELETE_LOG,
  PT_EXPORT_LOG,
  PT_IMPORT_LOG,
  PT_SHOW_LOG_IN_FOLDER,
} from "../config/shared/ipcChannels";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "../services/logger";

const log = withScope("profitTakerIpc");

/** Refresh must always answer: the record is on disk before the wait even starts,
 * so a stuck gzip costs a stale disk-usage figure, not a dead button. */
const REFRESH_WAIT_MS = 5000;

function asRunId(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? raw : null;
}

function runsPayload(): PtRunsPayload {
  return {
    runs: ptTracker.getPtRuns(),
    diskUsageBytes: ptTracker.getPtDiskUsageBytes(),
  };
}

async function awaitPendingSavesBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[PT] Pending run saves did not settle within ${REFRESH_WAIT_MS}ms`);
      resolve();
    }, REFRESH_WAIT_MS);
  });
  try {
    await Promise.race([ptTracker.awaitPendingPtSaves(), deadline]);
  } catch (err) {
    log.warn("[PT] Waiting for pending run saves failed:", normalizeErrorMessage(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function register(): void {
  handleAuthorized(PT_GET_RUNS, assertMainRendererSender, (): PtRunsPayload => runsPayload());

  handleAuthorized(PT_REFRESH_RUNS, assertMainRendererSender, async (): Promise<PtRunsPayload> => {
    try {
      forceEeLogPoll();
    } catch (err) {
      log.warn("[PT] Forced EE.log poll failed:", normalizeErrorMessage(err));
    }
    await awaitPendingSavesBounded();
    return runsPayload();
  });

  handleAuthorized(PT_SET_TAGS, assertMainRendererSender, (_event, id: unknown, tags: unknown) => {
    const runId = asRunId(id);
    if (!runId) return null;
    // normalizePtTags is total over unknown input: non-arrays -> [], junk entries dropped.
    return ptTracker.setPtRunTags(runId, normalizePtTags(tags));
  });

  handleAuthorized(
    PT_SET_NOTES,
    assertMainRendererSender,
    (_event, id: unknown, notes: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      // normalizePtNotes is total over unknown input: non-strings -> "", capped at 2000 chars.
      return ptTracker.setPtRunNotes(runId, normalizePtNotes(notes));
    },
  );

  handleAuthorized(PT_DELETE_RUN, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return { ok: runId ? ptTracker.deletePtRun(runId) : false };
  });

  handleAuthorized(PT_DELETE_LOG, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return runId ? ptTracker.deletePtRunLog(runId) : null;
  });

  handleAuthorized(PT_EXPORT_LOG, assertMainRendererSender, async (_event, id: unknown) => {
    const runId = asRunId(id);
    if (!runId) return { ok: false };
    const gzPath = ptTracker.getPtRunLogPath(runId);
    if (!gzPath || !ctx.mainWindow) return { ok: false };
    // Plain .log so the export can go straight back into any EE.log analyzer.
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      defaultPath: `profit-taker_${runId}.log`,
      filters: [{ name: "EE.log segment", extensions: ["log"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
      fs.writeFileSync(result.filePath, zlib.gunzipSync(fs.readFileSync(gzPath)));
      return { ok: true };
    } catch (err) {
      log.warn("[PT] Log export failed:", normalizeErrorMessage(err));
      return { ok: false };
    }
  });

  handleAuthorized(PT_IMPORT_LOG, assertMainRendererSender, async (): Promise<PtImportResult> => {
    const empty: PtImportResult = { imported: [], skipped: 0 };
    if (!ctx.mainWindow) return empty;
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: "Import EE.log",
      filters: [
        { name: "EE.log", extensions: ["log", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return empty;
    return importProfitTakerLog(result.filePaths[0]);
  });

  handleAuthorized(PT_SHOW_LOG_IN_FOLDER, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    const gzPath = runId ? ptTracker.getPtRunLogPath(runId) : null;
    if (gzPath) shell.showItemInFolder(path.resolve(gzPath));
    return { ok: gzPath !== null };
  });
}

export { register };
