const { app } = require("electron");
const { autoUpdater } = require("electron-updater");
const log = require("./logger").withScope("autoUpdater");

const UPDATE_STATUS_CHANNEL = "app-update-status";
const STARTUP_CHECK_DELAY_MS = 12_000;

/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
let initialized = false;
let checkPromise = null;
let startupTimer = null;

let updateState = {
  status: "idle",
  timestamp: Date.now(),
};

function emitUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(UPDATE_STATUS_CHANNEL, updateState);
}

function setUpdateState(status, patch = {}) {
  updateState = {
    ...updateState,
    ...patch,
    status,
    timestamp: Date.now(),
  };
  emitUpdateState();
}

function toMessage(errorLike) {
  if (errorLike && typeof errorLike === "object" && "message" in errorLike) {
    const msg = errorLike.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  if (typeof errorLike === "string" && errorLike.trim()) return errorLike.trim();
  return "Unknown updater error";
}

function toInfoPatch(info) {
  return {
    version: info?.version || null,
    releaseName: info?.releaseName || null,
    releaseDate: info?.releaseDate || null,
  };
}

function shouldEnableAutoUpdater() {
  if (process.env.WF_DISABLE_AUTO_UPDATE === "1") return false;
  return app.isPackaged;
}

function clearStartupCheck() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function initialize(windowRef) {
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

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info?.version);
    setUpdateState("available", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} found. Downloading...`.trim(),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    log.info("No updates available");
    setUpdateState("not-available", {
      ...toInfoPatch(info),
      message: "You are on the latest version.",
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState("downloading", {
      percent: typeof progress?.percent === "number" ? progress.percent : 0,
      bytesPerSecond: progress?.bytesPerSecond || 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
      message: "Downloading update...",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info?.version);
    setUpdateState("downloaded", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} downloaded. Restart to install.`.trim(),
    });
  });

  autoUpdater.on("error", (err) => {
    const message = toMessage(err);
    log.error("Updater error:", message);
    setUpdateState("error", { message });
  });

  startupTimer = setTimeout(() => {
    void checkForUpdates("startup");
  }, STARTUP_CHECK_DELAY_MS);
}

async function checkForUpdates(source = "manual") {
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
      const message = toMessage(err);
      setUpdateState("error", { message });
      return { ok: false, source, message, state: updateState };
    } finally {
      checkPromise = null;
    }
  })();

  return checkPromise;
}

function getUpdateState() {
  return { ...updateState };
}

function installDownloadedUpdate() {
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

module.exports = {
  UPDATE_STATUS_CHANNEL,
  initialize,
  checkForUpdates,
  getUpdateState,
  installDownloadedUpdate,
};
