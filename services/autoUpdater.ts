import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from "electron-updater";

import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { APP_UPDATE_STATUS } from "../config/shared/ipcChannels";

const log = withScope("autoUpdater");

const UPDATE_STATUS_CHANNEL = APP_UPDATE_STATUS;
const UPDATE_FEED_PROBE_TIMEOUT_MS = 5_000;
// Auto-check cadence. These timers only READ the public feed so the UI can
// flag a new version; downloads and installs always require a user click.
const STARTUP_UPDATE_CHECK_DELAY_MS = 8_000;
const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

let mainWindow: import("electron").BrowserWindow | null = null;
let initialized = false;
let checkPromise: Promise<{ ok: boolean; source: string; state: UpdateState }> | null = null;
let disabledReason: string | null = null;
let startupCheckTimer: ReturnType<typeof setTimeout> | null = null;
let periodicCheckTimer: ReturnType<typeof setInterval> | null = null;

interface UpdateState {
  status: string;
  timestamp: number;
  message?: string;
  version?: string | null;
  releaseName?: string | null;
  releaseDate?: string | null;
  releaseNotes?: string | null;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

interface UpdateConfig {
  provider?: string;
  owner?: string;
  repo?: string;
  host?: string;
}

interface FeedProbeResult {
  ok: boolean;
  statusCode: number;
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

function normalizeReleaseNotes(notes: UpdateInfo["releaseNotes"]): string | null {
  if (!notes) return null;
  if (typeof notes === "string") {
    const trimmed = notes.trim();
    return trimmed.length ? trimmed : null;
  }
  // Array<{ version, note }> when fullChangelog is enabled.
  const combined = notes
    .map((entry) => {
      const body = (entry?.note ?? "").trim();
      if (!body) return "";
      return entry?.version ? `## ${entry.version}\n\n${body}` : body;
    })
    .filter(Boolean)
    .join("\n\n");
  return combined.length ? combined : null;
}

function toInfoPatch(info: UpdateInfo): Partial<UpdateState> {
  return {
    version: info?.version || null,
    releaseName: info?.releaseName || null,
    releaseDate: info?.releaseDate || null,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
  };
}

function shouldEnableAutoUpdater(): boolean {
  if (process.env.WF_DISABLE_AUTO_UPDATE === "1") return false;
  if (!app.isPackaged) return false;
  // No linux release artifacts yet (latest-linux.yml 404s every boot).
  // Drop this gate when the linux release job ships.
  if (process.platform === "linux") return false;
  const ymlPath = path.join(process.resourcesPath, "app-update.yml");
  return fs.existsSync(ymlPath);
}

function readUpdateConfig(): UpdateConfig | null {
  const ymlPath = path.join(process.resourcesPath, "app-update.yml");
  if (!fs.existsSync(ymlPath)) return null;

  try {
    const raw = fs.readFileSync(ymlPath, "utf-8");
    const config: UpdateConfig = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^['"]|['"]$/g, "");
      if (match[1] === "provider") config.provider = value;
      if (match[1] === "owner") config.owner = value;
      if (match[1] === "repo") config.repo = value;
      if (match[1] === "host") config.host = value;
    }
    return config;
  } catch (err) {
    log.warn("Unable to read update config:", normalizeErrorMessage(err, "unknown error"));
    return null;
  }
}

function getPublicGithubFeedUrl(): string | null {
  const config = readUpdateConfig();
  if (!config || config.provider !== "github" || !config.owner || !config.repo) return null;

  const host = config.host || "github.com";
  if (host !== "github.com") return null;
  return `https://github.com/${config.owner}/${config.repo}/releases.atom`;
}

function probeFeed(url: string): Promise<FeedProbeResult> {
  return new Promise((resolve) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/atom+xml, application/xml, text/xml, */*" },
      },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        response.on("end", () => {
          resolve({ ok: statusCode >= 200 && statusCode < 400, statusCode });
        });
      },
    );

    request.setTimeout(UPDATE_FEED_PROBE_TIMEOUT_MS, () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0 });
    });
    request.on("error", () => resolve({ ok: false, statusCode: 0 }));
    request.end();
  });
}

async function ensureUpdateFeedReachable(): Promise<boolean> {
  if (disabledReason) return false;

  const feedUrl = getPublicGithubFeedUrl();
  if (!feedUrl) return true;

  const result = await probeFeed(feedUrl);
  if (result.ok || result.statusCode === 0) return true;

  if (result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 404) {
    disabledReason =
      "Auto-update feed is not publicly accessible. Publish updates from a public repository or configure a public update host.";
    log.warn(`${disabledReason} (${feedUrl} returned ${result.statusCode})`);
    setUpdateState("disabled", { message: disabledReason });
    return false;
  }

  return true;
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

  // Auto-check only: the timers below READ the public release feed so the UI can
  // flag a new version, but downloads and installs always wait for an explicit
  // user click. Exposure to a compromised feed stays limited to metadata reads.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = require("electron-log/main");

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates");
    setUpdateState("checking", { message: "Checking for updates..." });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    log.info("Update available:", info?.version);
    setUpdateState("available", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} available. Download when ready.`.trim(),
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    log.info("No updates available");
    setUpdateState("not-available", {
      ...toInfoPatch(info),
      message: "You are on the latest version.",
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setUpdateState("downloading", {
      percent: typeof progress?.percent === "number" ? progress.percent : 0,
      bytesPerSecond: progress?.bytesPerSecond || 0,
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
      message: "Downloading update...",
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    log.info("Update downloaded:", info?.version);
    setUpdateState("downloaded", {
      ...toInfoPatch(info),
      message: `Update ${info?.version || ""} downloaded. Restart to install.`.trim(),
    });
  });

  autoUpdater.on("error", (err: Error) => {
    const message = normalizeErrorMessage(err, "Unknown updater error");
    log.error("Updater error:", message);
    setUpdateState("error", { message });
  });

  scheduleAutoChecks();
}

// Read-only auto-checks so the UI can surface updates without a manual click.
// Never triggers a download or install - those stay user-driven.
function scheduleAutoChecks(): void {
  if (startupCheckTimer || periodicCheckTimer) return;

  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null;
    void checkForUpdates("startup");
  }, STARTUP_UPDATE_CHECK_DELAY_MS);
  startupCheckTimer.unref?.();

  periodicCheckTimer = setInterval(() => {
    // Don't interrupt an in-flight download or a ready-to-install update.
    if (updateState.status === "downloading" || updateState.status === "downloaded") return;
    void checkForUpdates("periodic");
  }, PERIODIC_UPDATE_CHECK_INTERVAL_MS);
  periodicCheckTimer.unref?.();
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
  if (!(await ensureUpdateFeedReachable())) {
    return { ok: false, source, message: disabledReason || "Auto-updater disabled.", state: updateState };
  }
  if (checkPromise) {
    return checkPromise;
  }

  checkPromise = (async () => {
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

export async function downloadUpdate(): Promise<{ ok: boolean; message?: string; state: UpdateState }> {
  if (!initialized) {
    return { ok: false, message: "Auto-updater not initialized.", state: updateState };
  }
  if (!shouldEnableAutoUpdater()) {
    return { ok: false, message: "Auto-updater disabled.", state: updateState };
  }
  if (updateState.status === "downloading") {
    return { ok: true, state: updateState };
  }
  if (updateState.status !== "available") {
    return { ok: false, message: "No update available to download.", state: updateState };
  }

  try {
    setUpdateState("downloading", { percent: 0, message: "Downloading update..." });
    await autoUpdater.downloadUpdate();
    return { ok: true, state: updateState };
  } catch (err) {
    const message = normalizeErrorMessage(err, "Unknown updater error");
    setUpdateState("error", { message });
    return { ok: false, message, state: updateState };
  }
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

