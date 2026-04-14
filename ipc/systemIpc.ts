import ctx from "./context";
import {
  assertAuthorizedSender,
  assertMainRendererSender,
  isAuthorizedSender,
} from "./ipcSecurity";
import { unwrapInventoryPayload } from "./inventoryPayload";
import { withScope } from "../services/logger";
import * as itemDb from "../services/itemDatabase";
import * as wfmCatalog from "../services/wfmCatalog";
import * as masteryHelper from "../services/masteryHelper";
import * as relicService from "../services/relicService";
import * as autoUpdater from "../services/autoUpdater";
import { normalizeErrorMessage } from "../config/shared/errors";
import { isAllowedExternalHost } from "../config/runtime/security";
import { ipcMain, shell } from "electron";
import {
  DB_GET_ITEM_DATABASE, DB_GET_WFM_ITEMS, DB_GET_MASTERY, DB_SET_DEBUG_MODE,
  DB_GET_RELIC_DATABASE,
  APP_UPDATE_CHECK, APP_UPDATE_STATE, APP_UPDATE_INSTALL,
  WINDOW_MINIMIZE, WINDOW_MAXIMIZE, WINDOW_CLOSE,
  LOG_WARN, OPEN_EXTERNAL,
} from "../config/shared/ipcChannels";

const log = withScope("systemIpc");

function register(): void {
  ipcMain.handle(DB_GET_ITEM_DATABASE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_ITEM_DATABASE);
    return itemDb.getRendererLookup();
  });

  ipcMain.handle(DB_GET_WFM_ITEMS, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_WFM_ITEMS);

    if (!wfmCatalog.isLoaded()) {
      try {
        await wfmCatalog.ensureLoaded();
      } catch (error) {
        log.warn("[WFMarket] get-wfm-items fetch failed:", normalizeErrorMessage(error));
      }
    }
    return wfmCatalog.getRendererLookup();
  });

  ipcMain.handle(DB_GET_MASTERY, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_MASTERY);

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

  ipcMain.handle(DB_SET_DEBUG_MODE, async (event: unknown, enabled: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_SET_DEBUG_MODE);

    masteryHelper.setDebugMode(Boolean(enabled));
    return { enabled: Boolean(enabled) };
  });

  ipcMain.handle(APP_UPDATE_CHECK, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, APP_UPDATE_CHECK);
    return autoUpdater.checkForUpdates("manual");
  });
  ipcMain.handle(APP_UPDATE_STATE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, APP_UPDATE_STATE);
    return autoUpdater.getUpdateState();
  });
  ipcMain.handle(APP_UPDATE_INSTALL, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, APP_UPDATE_INSTALL);
    return autoUpdater.installDownloadedUpdate();
  });

  ipcMain.handle(DB_GET_RELIC_DATABASE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_RELIC_DATABASE);
    return relicService.getRelicDatabase();
  });

  ipcMain.on(WINDOW_MINIMIZE, (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, WINDOW_MINIMIZE)) return;
    ctx.mainWindow?.minimize();
  });

  ipcMain.on(WINDOW_MAXIMIZE, (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, WINDOW_MAXIMIZE)) return;

    if (ctx.mainWindow?.isMaximized()) {
      ctx.mainWindow.unmaximize();
    } else {
      ctx.mainWindow?.maximize();
    }
  });

  ipcMain.on(WINDOW_CLOSE, (event: unknown) => {
    // Always allow close to proceed — this is a critical user action.
    // Log if the sender check would normally block it but still close,
    // since a broken close button effectively locks the user out.
    if (!isAuthorizedSender(assertMainRendererSender, event as never, WINDOW_CLOSE)) {
      log.warn("[SystemIpc] WINDOW_CLOSE sender check failed; closing anyway for safety");
    }
    ctx.mainWindow?.close();
  });

  ipcMain.on(LOG_WARN, (event: unknown, message: unknown, ...args: unknown[]) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, LOG_WARN)) return;
    log.warn("[renderer]", String(message), ...args);
  });

  ipcMain.on(OPEN_EXTERNAL, (event: unknown, url: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, OPEN_EXTERNAL)) return;

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
