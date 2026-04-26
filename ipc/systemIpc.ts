import ctx from "./context";
import {
  assertMainRendererSender,
  handleAuthorized,
  onAuthorized,
} from "./ipcSecurity";
import { unwrapInventoryPayload } from "../config/shared/inventoryPayload";
import { withScope } from "../services/logger";
import * as itemDb from "../services/itemDatabase";
import * as wfmCatalog from "../services/wfmCatalog";
import * as masteryHelper from "../services/masteryHelper";
import * as relicService from "../services/relicService";
import * as autoUpdater from "../services/autoUpdater";
import { normalizeErrorMessage } from "../config/shared/errors";
import { isAllowedExternalHost } from "../config/runtime/security";
import { shell } from "electron";
import {
  DB_GET_ITEM_DATABASE, DB_GET_WFM_ITEMS, DB_GET_MASTERY, DB_SET_DEBUG_MODE,
  DB_GET_RELIC_DATABASE,
  APP_UPDATE_CHECK, APP_UPDATE_STATE, APP_UPDATE_INSTALL,
  WINDOW_MINIMIZE, WINDOW_MAXIMIZE, WINDOW_CLOSE,
  LOG_WARN, OPEN_EXTERNAL,
} from "../config/shared/ipcChannels";

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

  handleAuthorized(DB_SET_DEBUG_MODE, assertMainRendererSender, (_event, enabled: unknown) => {
    masteryHelper.setDebugMode(Boolean(enabled));
    return { enabled: Boolean(enabled) };
  });

  handleAuthorized(APP_UPDATE_CHECK, assertMainRendererSender, () =>
    autoUpdater.checkForUpdates("manual"),
  );
  handleAuthorized(APP_UPDATE_STATE, assertMainRendererSender, () =>
    autoUpdater.getUpdateState(),
  );
  handleAuthorized(APP_UPDATE_INSTALL, assertMainRendererSender, () =>
    autoUpdater.installDownloadedUpdate(),
  );

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
