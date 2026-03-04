const log = require("../services/logger").withScope("systemIpc");
/**
 * System IPC handlers.
 * Handles: get-item-database, get-wfm-items, get-mastery-progress,
 *          set-debug-mode, get-relic-database,
 *          window-minimize, window-maximize, window-close, open-external
 */

const { ipcMain, shell } = require("electron");
const { isAllowedExternalHost } = require("../config/runtime/security");
const itemDb = require("../services/itemDatabase");
const wfMarket = require("../services/warframeMarket");
const masteryHelper = require("../services/masteryHelper");
const relicService = require("../services/relicService");
const autoUpdater = require("../services/autoUpdater");
const ctx = require("./context");

function register() {
  // Item database for renderer lookups (name -> image/displayName)
  ipcMain.handle("get-item-database", async () => itemDb.getRendererLookup());

  // Warframe.market item list for renderer lookups
  ipcMain.handle("get-wfm-items", async () => {
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
  ipcMain.handle("get-mastery-progress", async () => {
    if (!ctx.currentInventoryData) return null;

    // Unwrap AlecaFrame's InventoryJson envelope if present
    let data = ctx.currentInventoryData;
    if (data?.InventoryJson && !data?.Suits) {
      data = data.InventoryJson;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (e) {
          log.error("[Mastery] Failed to parse InventoryJson:", e.message);
          return null;
        }
      }
    }

    return masteryHelper.computeMasteryProgress(data);
  });

  // Toggle verbose debug logging in the mastery classifier
  ipcMain.handle("set-debug-mode", async (_event, enabled) => {
    masteryHelper.setDebugMode(!!enabled);
    return { enabled: !!enabled };
  });

  ipcMain.handle("app:update-check", async () => autoUpdater.checkForUpdates("manual"));
  ipcMain.handle("app:update-state", async () => autoUpdater.getUpdateState());
  ipcMain.handle("app:update-install", async () => autoUpdater.installDownloadedUpdate());

  // Full relic database for the relic planner view
  ipcMain.handle("get-relic-database", async () => relicService.getRelicDatabase());

  // Window controls (custom titlebar)
  ipcMain.on("window-minimize", () => ctx.mainWindow?.minimize());

  ipcMain.on("window-maximize", () => {
    if (ctx.mainWindow?.isMaximized()) {
      ctx.mainWindow.unmaximize();
    } else {
      ctx.mainWindow?.maximize();
    }
  });

  ipcMain.on("window-close", () => ctx.mainWindow?.close());

  // Safe external link opener.
  // Allows only HTTPS URLs to approved domains.
  ipcMain.on("open-external", (_event, url) => {
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
