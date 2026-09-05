import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dialog, shell } from "electron";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import { forceEeLogPoll } from "../services/eeLogMonitor";
import type { ScopedLogger } from "../services/logger";
import { normalizeArbiNotes, normalizeArbiTags } from "../config/shared/arbiTypes";
import { normalizeErrorMessage } from "../config/shared/errors";

/** Refresh must always answer: the record is on disk before the wait even starts,
 * so a stuck gzip costs a stale disk-usage figure, not a dead button. */
const REFRESH_WAIT_MS = 5000;

export function asRunId(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? raw : null;
}

interface RunTrackerChannels {
  getRuns: string;
  refreshRuns: string;
  setTags: string;
  setNotes: string;
  deleteRun: string;
  deleteLog: string;
  exportLog: string;
  importLog: string;
  showLogInFolder: string;
}

/** What the list handlers answer with. Each feature passes its own IPC contract
 * type, so a payload that drifted from the renderer's fails tsc here. */
interface RunsPayloadShape {
  runs: unknown[];
  diskUsageBytes: number;
}

interface ImportResultShape<TRunsPayload extends RunsPayloadShape> {
  imported: TRunsPayload["runs"];
  skipped: number;
}

/** The slice of a run tracker module the shared handlers call. */
interface RunTrackerApi<TRunsPayload extends RunsPayloadShape> {
  getRuns(): TRunsPayload["runs"];
  getDiskUsageBytes(): number;
  awaitPendingSaves(): Promise<void>;
  setRunTags(id: string, tags: string[]): TRunsPayload["runs"][number] | null;
  setRunNotes(id: string, notes: string): TRunsPayload["runs"][number] | null;
  deleteRun(id: string): boolean;
  deleteRunLog(id: string): TRunsPayload["runs"][number] | null;
  getRunLogPath(id: string): string | null;
}

interface RunTrackerIpcSpec<
  TRunsPayload extends RunsPayloadShape,
  TImportResult extends ImportResultShape<TRunsPayload>,
> {
  log: ScopedLogger;
  /** Log prefix, e.g. "[Arbi]". */
  label: string;
  channels: RunTrackerChannels;
  tracker: RunTrackerApi<TRunsPayload>;
  importLog(filePath: string): Promise<TImportResult>;
  /** Filesystem-safe export name without extension, e.g. "Casta_Ceres_2026-07-04_21-30-15". */
  exportBaseName(id: string): string;
}

/** Registers the run list, annotation, delete, import and export handlers every
 * EE.log run tracker exposes; a feature adds its own channels on top. */
export function registerRunTrackerIpc<
  TRunsPayload extends RunsPayloadShape,
  TImportResult extends ImportResultShape<TRunsPayload>,
>(spec: RunTrackerIpcSpec<TRunsPayload, TImportResult>): void {
  const { log, label: L, channels, tracker } = spec;

  const runsPayload = (): { runs: TRunsPayload["runs"]; diskUsageBytes: number } => ({
    runs: tracker.getRuns(),
    diskUsageBytes: tracker.getDiskUsageBytes(),
  });

  async function awaitPendingSavesBounded(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`${L} Pending run saves did not settle within ${REFRESH_WAIT_MS}ms`);
        resolve();
      }, REFRESH_WAIT_MS);
    });
    try {
      await Promise.race([tracker.awaitPendingSaves(), deadline]);
    } catch (err) {
      log.warn(`${L} Waiting for pending run saves failed:`, normalizeErrorMessage(err));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  handleAuthorized(channels.getRuns, assertMainRendererSender, () => runsPayload());

  handleAuthorized(channels.refreshRuns, assertMainRendererSender, async () => {
    try {
      forceEeLogPoll();
    } catch (err) {
      log.warn(`${L} Forced EE.log poll failed:`, normalizeErrorMessage(err));
    }
    await awaitPendingSavesBounded();
    return runsPayload();
  });

  handleAuthorized(
    channels.setTags,
    assertMainRendererSender,
    (_event, id: unknown, tags: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      // normalizeArbiTags is total over unknown input: non-arrays -> [], junk entries dropped.
      return tracker.setRunTags(runId, normalizeArbiTags(tags));
    },
  );

  handleAuthorized(
    channels.setNotes,
    assertMainRendererSender,
    (_event, id: unknown, notes: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      // normalizeArbiNotes is total over unknown input: non-strings -> "", capped at 2000 chars.
      return tracker.setRunNotes(runId, normalizeArbiNotes(notes));
    },
  );

  handleAuthorized(channels.deleteRun, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return { ok: runId ? tracker.deleteRun(runId) : false };
  });

  handleAuthorized(channels.deleteLog, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return runId ? tracker.deleteRunLog(runId) : null;
  });

  handleAuthorized(channels.exportLog, assertMainRendererSender, async (_event, id: unknown) => {
    const runId = asRunId(id);
    if (!runId) return { ok: false };
    const gzPath = tracker.getRunLogPath(runId);
    if (!gzPath || !ctx.mainWindow) return { ok: false };
    // Plain .log so the export can go straight back into any EE.log analyzer.
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      defaultPath: `${spec.exportBaseName(runId)}.log`,
      filters: [{ name: "EE.log segment", extensions: ["log"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
      fs.writeFileSync(result.filePath, zlib.gunzipSync(fs.readFileSync(gzPath)));
      return { ok: true };
    } catch (err) {
      log.warn(`${L} Log export failed:`, normalizeErrorMessage(err));
      return { ok: false };
    }
  });

  handleAuthorized(channels.importLog, assertMainRendererSender, async () => {
    const empty: ImportResultShape<TRunsPayload> = { imported: [], skipped: 0 };
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
    return spec.importLog(result.filePaths[0]);
  });

  handleAuthorized(channels.showLogInFolder, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    const gzPath = runId ? tracker.getRunLogPath(runId) : null;
    if (gzPath) shell.showItemInFolder(path.resolve(gzPath));
    return { ok: gzPath !== null };
  });
}
