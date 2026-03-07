import ctx from "./context";
import {
  assertAuthorizedSender,
  assertMainRendererSender,
  isAuthorizedSender,
} from "./ipcSecurity";
import { unwrapInventoryPayload } from "./inventoryPayload";
import { createRuntimeRequire } from "./runtimeRequire";

export {};

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("systemIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, shell } = require("electron") as typeof import("electron");
const { isAllowedExternalHost } = requireRuntime<{
  isAllowedExternalHost: (hostname: string) => boolean;
}>("config/runtime/security");
const itemDb = requireRuntime<{ getRendererLookup: () => unknown }>("services/itemDatabase");
const wfmCatalog = requireRuntime<{
  isLoaded: () => boolean;
  ensureLoaded: () => Promise<unknown>;
  getRendererLookup: () => unknown;
}>("services/wfmCatalog");
const masteryHelper = requireRuntime<{
  computeMasteryProgress: (data: unknown) => unknown;
  setDebugMode: (enabled: boolean) => void;
}>("services/masteryHelper");
const relicService = requireRuntime<{ getRelicDatabase: () => unknown }>("services/relicService");
const autoUpdater = requireRuntime<{
  checkForUpdates: (reason: string) => Promise<unknown>;
  getUpdateState: () => unknown;
  installDownloadedUpdate: () => Promise<unknown>;
}>("services/autoUpdater");

function register(): void {
  ipcMain.handle("get-item-database", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-item-database");
    return itemDb.getRendererLookup();
  });

  ipcMain.handle("get-wfm-items", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-wfm-items");

    if (!wfmCatalog.isLoaded()) {
      try {
        await wfmCatalog.ensureLoaded();
      } catch (error) {
        log.warn("[WFMarket] get-wfm-items fetch failed:", normalizeErrorMessage(error));
      }
    }
    return wfmCatalog.getRendererLookup();
  });

  ipcMain.handle("get-mastery-progress", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-mastery-progress");

    if (!ctx.currentInventoryData) return null;

    const data = unwrapInventoryPayload(ctx.currentInventoryData, {
      onParseError: (error: unknown) =>
        log.error(
          "[Mastery] Failed to parse nested inventory payload:",
          normalizeErrorMessage(error),
        ),
    });
    return masteryHelper.computeMasteryProgress(data);
  });

  ipcMain.handle("set-debug-mode", async (event: unknown, enabled: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "set-debug-mode");

    masteryHelper.setDebugMode(Boolean(enabled));
    return { enabled: Boolean(enabled) };
  });

  ipcMain.handle("app:update-check", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "app:update-check");
    return autoUpdater.checkForUpdates("manual");
  });
  ipcMain.handle("app:update-state", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "app:update-state");
    return autoUpdater.getUpdateState();
  });
  ipcMain.handle("app:update-install", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "app:update-install");
    return autoUpdater.installDownloadedUpdate();
  });

  ipcMain.handle("get-relic-database", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-relic-database");
    return relicService.getRelicDatabase();
  });

  ipcMain.on("window-minimize", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "window-minimize")) return;
    ctx.mainWindow?.minimize();
  });

  ipcMain.on("window-maximize", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "window-maximize")) return;

    if (ctx.mainWindow?.isMaximized()) {
      ctx.mainWindow.unmaximize();
    } else {
      ctx.mainWindow?.maximize();
    }
  });

  ipcMain.on("window-close", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "window-close")) return;
    ctx.mainWindow?.close();
  });

  ipcMain.on("open-external", (event: unknown, url: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "open-external")) return;

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

module.exports = { register };
