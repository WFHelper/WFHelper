import ctx from "./context";
import { assertMainRendererSender, handleAuthorized, onAuthorized } from "./ipcSecurity";
import { unwrapInventoryPayload } from "../config/shared/inventoryPayload";
import { getLogDirectory, withScope } from "../services/logger";
import * as itemDb from "../services/itemDatabase";
import * as wfmCatalog from "../services/wfmCatalog";
import * as masteryHelper from "../services/masteryHelper";
import * as relicService from "../services/relicService";
import * as dropData from "../services/dropData";
import * as autoUpdater from "../services/autoUpdater";
import { normalizeErrorMessage } from "../config/shared/errors";
import { isAllowedExternalHost } from "../config/runtime/security";
import { app, shell } from "electron";
import {
  DB_GET_ITEM_DATABASE,
  DB_GET_WFM_ITEMS,
  DB_GET_MASTERY,
  DB_GET_RELIC_DATABASE,
  DROP_SEARCH,
  APP_UPDATE_CHECK,
  APP_UPDATE_STATE,
  APP_UPDATE_DOWNLOAD,
  APP_UPDATE_INSTALL,
  APP_RUNTIME_INFO,
  SCAN_DEBUG_OPEN_FOLDER,
  LOGS_OPEN_FOLDER,
  WINDOW_MINIMIZE,
  WINDOW_MAXIMIZE,
  WINDOW_CLOSE,
  LOG_WARN,
  OPEN_EXTERNAL,
} from "../config/shared/ipcChannels";
import fs from "node:fs";
import { getScanDebugDir } from "../services/rewardScanDebug";
import { isObject, trimmedString } from "./ipcValidators";

const log = withScope("systemIpc");

function register(): void {
  handleAuthorized(DB_GET_ITEM_DATABASE, assertMainRendererSender, () =>
    itemDb.getRendererLookup(),
  );

  handleAuthorized(DB_GET_WFM_ITEMS, assertMainRendererSender, async () => {
    if (!wfmCatalog.isLoaded()) {
      try {
        await wfmCatalog.ensureLoaded();
      } catch (error) {
        log.warn("[WFMarket] get-wfm-items fetch failed:", normalizeErrorMessage(error));
      }
    }
    return wfmCatalog.getRendererLookup();
  });

  handleAuthorized(DB_GET_MASTERY, assertMainRendererSender, () => {
    if (!ctx.currentInventoryData) return null;

    const data = unwrapInventoryPayload(ctx.currentInventoryData, {
      onParseError: (error: unknown) =>
        log.error(
          "[Mastery] Failed to parse nested inventory payload:",
          normalizeErrorMessage(error),
        ),
    });
    return masteryHelper.computeMasteryProgress(data as Record<string, unknown>);
  });

  handleAuthorized(DROP_SEARCH, assertMainRendererSender, async (_event, payload: unknown) => {
    if (!isObject(payload)) return [];
    const query = trimmedString(payload.query, 200);
    const mode = payload.mode === "item" || payload.mode === "place" ? payload.mode : null;
    if (!query || !mode) return [];
    try {
      await dropData.ensureLoaded();
    } catch (error) {
      log.warn("[Drops] ensureLoaded failed:", normalizeErrorMessage(error));
    }
    return dropData.searchDrops(query, mode);
  });

  handleAuthorized(APP_UPDATE_CHECK, assertMainRendererSender, () =>
    autoUpdater.checkForUpdates("manual"),
  );
  handleAuthorized(APP_UPDATE_STATE, assertMainRendererSender, () => autoUpdater.getUpdateState());
  handleAuthorized(APP_UPDATE_DOWNLOAD, assertMainRendererSender, () =>
    autoUpdater.downloadUpdate(),
  );
  handleAuthorized(APP_UPDATE_INSTALL, assertMainRendererSender, () =>
    autoUpdater.installDownloadedUpdate(),
  );
  handleAuthorized(SCAN_DEBUG_OPEN_FOLDER, assertMainRendererSender, async () => {
    try {
      const dir = getScanDebugDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const openErr = await shell.openPath(dir);
      if (openErr) log.warn(`[SystemIPC] openPath(scan-debug) failed: ${openErr}`);
      return { ok: !openErr };
    } catch (err) {
      log.warn("[SystemIPC] open scan-debug folder failed:", normalizeErrorMessage(err));
      return { ok: false };
    }
  });

  handleAuthorized(LOGS_OPEN_FOLDER, assertMainRendererSender, async () => {
    try {
      const dir = getLogDirectory();
      if (!dir) return { ok: false };
      const openErr = await shell.openPath(dir);
      if (openErr) log.warn(`[SystemIPC] openPath(logs) failed: ${openErr}`);
      return { ok: !openErr };
    } catch (err) {
      log.warn("[SystemIPC] open log folder failed:", normalizeErrorMessage(err));
      return { ok: false };
    }
  });

  handleAuthorized(APP_RUNTIME_INFO, assertMainRendererSender, () => ({
    isPackaged: app.isPackaged,
  }));

  handleAuthorized(DB_GET_RELIC_DATABASE, assertMainRendererSender, () =>
    relicService.getRelicDatabase(),
  );

  onAuthorized(WINDOW_MINIMIZE, assertMainRendererSender, () => {
    ctx.mainWindow?.minimize();
  });

  onAuthorized(WINDOW_MAXIMIZE, assertMainRendererSender, () => {
    if (ctx.mainWindow?.isMaximized()) {
      ctx.mainWindow.unmaximize();
    } else {
      ctx.mainWindow?.maximize();
    }
  });

  onAuthorized(WINDOW_CLOSE, assertMainRendererSender, () => {
    ctx.mainWindow?.close();
  });

  onAuthorized(
    LOG_WARN,
    assertMainRendererSender,
    (_event, message: unknown, ...args: unknown[]) => {
      log.warn("[renderer]", String(message), ...args);
    },
  );

  onAuthorized(OPEN_EXTERNAL, assertMainRendererSender, (_event, url: unknown) => {
    try {
      const parsed = new URL(String(url));
      const isHttps = parsed.protocol === "https:";
      if (isHttps && isAllowedExternalHost(parsed.hostname)) {
        void shell.openExternal(parsed.toString());
      } else {
        log.warn(
          "[Security] Blocked open-external for protocol/host:",
          parsed.protocol,
          parsed.hostname,
        );
      }
    } catch {
      log.warn("[Security] Blocked open-external with invalid URL:", String(url).slice(0, 100));
    }
  });
}

export { register };
