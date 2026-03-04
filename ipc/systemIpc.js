const log = require("../services/logger").withScope("systemIpc");
/**
 * System IPC handlers.
 * Handles: get-item-database, get-wfm-items, get-mastery-progress,
 *          set-debug-mode, get-relic-database,
 *          window-minimize, window-maximize, window-close, open-external
 */

const { ipcMain, shell } = require("electron");
const { isAllowedExternalHost } = require("../config/runtime/security");
const {
  assertMainRendererSender,
  assertAuthorizedSender,
  isAuthorizedSender,
} = require("./ipcSecurity");
const { unwrapInventoryPayload } = require("./inventoryPayload");
const itemDb = require("../services/itemDatabase");
const wfMarket = require("../services/warframeMarket");
const masteryHelper = require("../services/masteryHelper");
const relicService = require("../services/relicService");
const autoUpdater = require("../services/autoUpdater");
const ctx = require("./context");

function register() {
  // Item database for renderer lookups (name -> image/displayName)
  ipcMain.handle("get-item-database", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-item-database");
    return itemDb.getRendererLookup();
  });

  // Warframe.market item list for renderer lookups
  ipcMain.handle("get-wfm-items", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-wfm-items");

    if (!wfMarket.isLoaded()) {
      try {
        await wfMarket.fetchItemList();
      } catch (error) {
        log.warn(
          "[WFMarket] get-wfm-items fetch failed:",
          error && typeof error === "object" && error.message ? error.message : String(error),
        );
      }
    }
    return wfMarket.getRendererLookup();
  });

  // Compute mastery progress from last loaded inventory
  ipcMain.handle("get-mastery-progress", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-mastery-progress");

    if (!ctx.currentInventoryData) return null;

    const data = unwrapInventoryPayload(ctx.currentInventoryData, {
      onParseError: (error) =>
        log.error(
          "[Mastery] Failed to parse nested inventory payload:",
          error?.message || String(error),
        ),
    });
    return masteryHelper.computeMasteryProgress(data);
  });

  // Toggle verbose debug logging in the mastery classifier
  ipcMain.handle("set-debug-mode", async (event, enabled) => {
    assertAuthorizedSender(assertMainRendererSender, event, "set-debug-mode");

    masteryHelper.setDebugMode(!!enabled);
    return { enabled: !!enabled };
  });

  ipcMain.handle("app:update-check", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "app:update-check");
    return autoUpdater.checkForUpdates("manual");
  });
  ipcMain.handle("app:update-state", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "app:update-state");
    return autoUpdater.getUpdateState();
  });
  ipcMain.handle("app:update-install", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "app:update-install");
    return autoUpdater.installDownloadedUpdate();
  });

  // Full relic database for the relic planner view
  ipcMain.handle("get-relic-database", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-relic-database");
    return relicService.getRelicDatabase();
  });

  // Window controls (custom titlebar)
  ipcMain.on("window-minimize", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "window-minimize")) return;
    ctx.mainWindow?.minimize();
  });

  ipcMain.on("window-maximize", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "window-maximize")) return;

    if (ctx.mainWindow?.isMaximized()) {
      ctx.mainWindow.unmaximize();
    } else {
      ctx.mainWindow?.maximize();
    }
  });

  ipcMain.on("window-close", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "window-close")) return;
    ctx.mainWindow?.close();
  });

  // Safe external link opener.
  // Allows only HTTPS URLs to approved domains.
  ipcMain.on("open-external", (event, url) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "open-external")) return;

    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      if (isHttps && isAllowedExternalHost(parsed.hostname)) {
        shell.openExternal(url);
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

module.exports = { register };
