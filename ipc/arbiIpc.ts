import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dialog, shell } from "electron";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as arbiRunTracker from "../services/arbiRunTracker";
import { importEeLog } from "../services/arbiLogImporter";
import { forceEeLogPoll } from "../services/eeLogMonitor";
import type { ArbiImportResult, ArbiRunsPayload } from "../config/shared/arbiTypes";
import { normalizeArbiNotes, normalizeArbiTags } from "../config/shared/arbiTypes";
import {
  ARBI_GET_RUNS,
  ARBI_REFRESH_RUNS,
  ARBI_SET_VITUS,
  ARBI_SET_TAGS,
  ARBI_SET_NOTES,
  ARBI_DELETE_RUN,
  ARBI_DELETE_LOG,
  ARBI_EXPORT_LOG,
  ARBI_IMPORT_LOG,
  ARBI_SAVE_IMAGE,
  ARBI_SHOW_LOG_IN_FOLDER,
} from "../config/shared/ipcChannels";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "../services/logger";

const log = withScope("arbiIpc");

const MAX_VITUS = 10_000_000;
/** 20 MiB PNG cap for dashboard exports. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Refresh must always answer: the record is on disk before the wait even starts,
 * so a stuck gzip costs a stale disk-usage figure, not a dead button. */
const REFRESH_WAIT_MS = 5000;

function asRunId(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? raw : null;
}

/** Filesystem-safe export name from the node, e.g. "Casta_Ceres_2026-07-04_21-30-15". */
function exportBaseName(id: string): string {
  const run = arbiRunTracker.getRuns().find((r) => r.id === id);
  const node = (run?.node ?? "arbitration").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "arbitration";
  return `${node.replace(/\s+/g, "_")}_${id}`;
}

function runsPayload(): ArbiRunsPayload {
  return {
    runs: arbiRunTracker.getRuns(),
    diskUsageBytes: arbiRunTracker.getDiskUsageBytes(),
  };
}

async function awaitPendingSavesBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[Arbi] Pending run saves did not settle within ${REFRESH_WAIT_MS}ms`);
      resolve();
    }, REFRESH_WAIT_MS);
  });
  try {
    await Promise.race([arbiRunTracker.awaitPendingArbiSaves(), deadline]);
  } catch (err) {
    log.warn("[Arbi] Waiting for pending run saves failed:", normalizeErrorMessage(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function register(): void {
  handleAuthorized(ARBI_GET_RUNS, assertMainRendererSender, (): ArbiRunsPayload => runsPayload());

  handleAuthorized(
    ARBI_REFRESH_RUNS,
    assertMainRendererSender,
    async (): Promise<ArbiRunsPayload> => {
      try {
        forceEeLogPoll();
      } catch (err) {
        log.warn("[Arbi] Forced EE.log poll failed:", normalizeErrorMessage(err));
      }
      await awaitPendingSavesBounded();
      return runsPayload();
    },
  );

  handleAuthorized(
    ARBI_SET_VITUS,
    assertMainRendererSender,
    (_event, id: unknown, vitus: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      let value: number | null = null;
      if (typeof vitus === "number") {
        if (!Number.isFinite(vitus) || vitus < 0 || vitus > MAX_VITUS) return null;
        value = Math.round(vitus);
      } else if (vitus !== null) {
        return null;
      }
      return arbiRunTracker.setRunVitus(runId, value);
    },
  );

  handleAuthorized(
    ARBI_SET_TAGS,
    assertMainRendererSender,
    (_event, id: unknown, tags: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      // normalizeArbiTags is total over unknown input: non-arrays -> [], junk entries dropped.
      return arbiRunTracker.setRunTags(runId, normalizeArbiTags(tags));
    },
  );

  handleAuthorized(
    ARBI_SET_NOTES,
    assertMainRendererSender,
    (_event, id: unknown, notes: unknown) => {
      const runId = asRunId(id);
      if (!runId) return null;
      // normalizeArbiNotes is total over unknown input: non-strings -> "", capped at 2000 chars.
      return arbiRunTracker.setRunNotes(runId, normalizeArbiNotes(notes));
    },
  );

  handleAuthorized(ARBI_DELETE_RUN, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return { ok: runId ? arbiRunTracker.deleteRun(runId) : false };
  });

  handleAuthorized(ARBI_DELETE_LOG, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    return runId ? arbiRunTracker.deleteRunLog(runId) : null;
  });

  handleAuthorized(ARBI_EXPORT_LOG, assertMainRendererSender, async (_event, id: unknown) => {
    const runId = asRunId(id);
    if (!runId) return { ok: false };
    const gzPath = arbiRunTracker.getRunLogPath(runId);
    if (!gzPath || !ctx.mainWindow) return { ok: false };
    // Plain .log so the export can go straight back into any EE.log analyzer.
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      defaultPath: `${exportBaseName(runId)}.log`,
      filters: [{ name: "EE.log segment", extensions: ["log"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
      fs.writeFileSync(result.filePath, zlib.gunzipSync(fs.readFileSync(gzPath)));
      return { ok: true };
    } catch (err) {
      log.warn("[Arbi] Log export failed:", normalizeErrorMessage(err));
      return { ok: false };
    }
  });

  handleAuthorized(
    ARBI_SAVE_IMAGE,
    assertMainRendererSender,
    async (_event, id: unknown, png: unknown) => {
      const runId = asRunId(id);
      if (!runId || !ctx.mainWindow) return { ok: false };
      if (
        !(png instanceof Uint8Array) ||
        png.byteLength === 0 ||
        png.byteLength > MAX_IMAGE_BYTES
      ) {
        return { ok: false };
      }
      const result = await dialog.showSaveDialog(ctx.mainWindow, {
        defaultPath: `${exportBaseName(runId)}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (result.canceled || !result.filePath) return { ok: false };
      try {
        fs.writeFileSync(result.filePath, Buffer.from(png.buffer, png.byteOffset, png.byteLength));
        return { ok: true };
      } catch (err) {
        log.warn("[Arbi] Image export failed:", normalizeErrorMessage(err));
        return { ok: false };
      }
    },
  );

  handleAuthorized(
    ARBI_IMPORT_LOG,
    assertMainRendererSender,
    async (): Promise<ArbiImportResult> => {
      const empty: ArbiImportResult = { imported: [], skipped: 0 };
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
      return importEeLog(result.filePaths[0]);
    },
  );

  handleAuthorized(ARBI_SHOW_LOG_IN_FOLDER, assertMainRendererSender, (_event, id: unknown) => {
    const runId = asRunId(id);
    const gzPath = runId ? arbiRunTracker.getRunLogPath(runId) : null;
    if (gzPath) shell.showItemInFolder(path.resolve(gzPath));
    return { ok: gzPath !== null };
  });
}

export { register };
