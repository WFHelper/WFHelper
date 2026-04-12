import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

const log = withScope("autoUpdater");

const UPDATE_STATUS_CHANNEL = "app-update-status";
const STARTUP_CHECK_DELAY_MS = 12_000;

let mainWindow: import("electron").BrowserWindow | null = null;
let initialized = false;
let checkPromise: Promise<any> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

interface UpdateState {
  status: string;
  timestamp: number;
  message?: string;
  version?: string | null;
  releaseName?: string | null;
  releaseDate?: string | null;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

let updateState: UpdateState = {
  status: "idle",
  timestamp: Date.now(),
};

function emitUpdateState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, updateState);
}

function setUpdateState(status: string, patch: Partial<UpdateState> = {}): void {
  updateState = {
    ...updateState,
    ...patch,
    status,
    timestamp: Date.now(),
  };
  emitUpdateState();
}

function toInfoPatch(info: any): Partial<UpdateState> {
  return {
    version: info?.version || null,
    releaseName: info?.releaseName || null,
    releaseDate: info?.releaseDate || null,
  };
}

function shouldEnableAutoUpdater(): boolean {
  if (process.env.WF_DISABLE_AUTO_UPDATE === "1") return false;
  return app.isPackaged;
}

function clearStartupCheck(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

export function initialize(windowRef: import("electron").BrowserWindow): void {
  mainWindow = windowRef;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once("did-finish-load", emitUpdateState);
  }

  if (initialized) return;
  initialized = true;

  if (!shouldEnableAutoUpdater()) {
    setUpdateState("disabled", {
      message: "Auto-update disabled in development mode.",
    });
    log.info("Auto-updater disabled");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = require("electron-log/main");

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates");
    setUpdateState("checking", { message: "Checking for updates..." });
  });

  autoUpdater.on("update-available", (info: any) => {
    log.info("Update available:", info?.version);
    setUpdateState("available", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} found. Downloading...`.trim(),
    });
  });

  autoUpdater.on("update-not-available", (info: any) => {
    log.info("No updates available");
    setUpdateState("not-available", {
      ...toInfoPatch(info),
      message: "You are on the latest version.",
    });
  });

  autoUpdater.on("download-progress", (progress: any) => {
    setUpdateState("downloading", {
      percent: typeof progress?.percent === "number" ? progress.percent : 0,
      bytesPerSecond: progress?.bytesPerSecond || 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
      message: "Downloading update...",
    });
  });

  autoUpdater.on("update-downloaded", (info: any) => {
    log.info("Update downloaded:", info?.version);
    setUpdateState("downloaded", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} downloaded. Restart to install.`.trim(),
    });
  });

  autoUpdater.on("error", (err: any) => {
    const message = normalizeErrorMessage(err, "Unknown updater error");
    log.error("Updater error:", message);
    setUpdateState("error", { message });
  });

  startupTimer = setTimeout(() => {
    void checkForUpdates("startup");
  }, STARTUP_CHECK_DELAY_MS);
}

export async function checkForUpdates(
  source: string = "manual",
): Promise<{ ok: boolean; source?: string; message?: string; state: UpdateState }> {
  if (!initialized) {
    return { ok: false, message: "Auto-updater not initialized.", state: updateState };
  }
  if (!shouldEnableAutoUpdater()) {
    return { ok: false, message: "Auto-updater disabled.", state: updateState };
  }
  if (checkPromise) {
    return checkPromise;
  }

  checkPromise = (async () => {
    clearStartupCheck();
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true, source, state: updateState };
    } catch (err) {
      const message = normalizeErrorMessage(err, "Unknown updater error");
      setUpdateState("error", { message });
      return { ok: false, source, message, state: updateState };
    } finally {
      checkPromise = null;
    }
  })();

  return checkPromise;
}

export function getUpdateState(): UpdateState {
  return { ...updateState };
}

export function installDownloadedUpdate(): { ok: boolean; message?: string } {
  if (updateState.status !== "downloaded") {
    return { ok: false, message: "No downloaded update is ready to install." };
  }

  setUpdateState("installing", {
    message: "Restarting to install update...",
  });

  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 250);

  return { ok: true };
}

export { UPDATE_STATUS_CHANNEL };