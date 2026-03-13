/**
 * Runs warframe-api-helper.exe in the background (no CMD window) on a timer.
 * After each run, the existing chokidar file-watcher on inventory.json picks up changes.
 */

import { withScope } from "./logger";

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const https = require("node:https") as typeof import("node:https");
const http = require("node:http") as typeof import("node:http");
const { spawn } = require("node:child_process") as typeof import("node:child_process");
const { app } = require("electron") as typeof import("electron");

const log = withScope("apiHelperRunner");

const EXE_NAME = "warframe-api-helper.exe";
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Sainan/warframe-api-helper/releases/latest";

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _running = false;
let _lastRunAt: number | null = null;
let _lastRunOk: boolean | null = null;
let _exePath: string | null = null;

export interface HelperStatus {
  exeFound: boolean;
  running: boolean;
  lastRunAt: number | null; // unix ms
  lastRunOk: boolean | null;
  inventoryLastModified: number | null; // unix ms
}

export interface DownloadProgress {
  stage: "resolving" | "downloading" | "done" | "error";
  percent: number; // 0-100
  bytesReceived: number;
  bytesTotal: number;
  error?: string;
}

/** Directory where we store the downloaded helper. */
function getHelperDir(): string {
  return path.join(app.getPath("userData"), "api-helper");
}

function findExePath(): string | null {
  // Check userData install location first (auto-downloaded).
  const candidates = [
    path.join(getHelperDir(), EXE_NAME),
    path.join(process.cwd(), "api-inventory-data", EXE_NAME),
    path.join(process.cwd(), EXE_NAME),
    path.join(app.getPath("downloads"), EXE_NAME),
    path.join(app.getPath("desktop"), EXE_NAME),
    path.join(app.getPath("documents"), EXE_NAME),
    path.join(app.getPath("home"), EXE_NAME),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function getInventoryMtime(): number | null {
  if (!_exePath) return null;
  const dir = path.dirname(_exePath);
  const inventoryPath = path.join(dir, "inventory.json");
  try {
    const stats = fs.statSync(inventoryPath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export function getStatus(): HelperStatus {
  return {
    exeFound: _exePath !== null,
    running: _running,
    lastRunAt: _lastRunAt,
    lastRunOk: _lastRunOk,
    inventoryLastModified: getInventoryMtime(),
  };
}

/**
 * Run the helper exe once and resolve when it exits.
 * Uses `windowsHide: true` so no CMD window appears.
 */
export function runOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!_exePath) {
      _exePath = findExePath();
    }
    if (!_exePath) {
      log.warn("warframe-api-helper.exe not found — skipping run");
      _lastRunOk = false;
      resolve(false);
      return;
    }

    if (_running) {
      log.log("Helper already running — skipping");
      resolve(false);
      return;
    }

    _running = true;
    log.log("Running warframe-api-helper…");

    const child = spawn(_exePath, [], {
      cwd: path.dirname(_exePath),
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });

    child.on("error", (err: Error) => {
      log.error("Helper spawn error:", err.message);
      _running = false;
      _lastRunOk = false;
      _lastRunAt = Date.now();
      resolve(false);
    });

    child.on("exit", (code: number | null) => {
      _running = false;
      _lastRunAt = Date.now();
      _lastRunOk = code === 0;
      if (code !== 0) {
        log.warn(`Helper exited with code ${code}`);
      } else {
        log.log("Helper finished successfully");
      }
      resolve(code === 0);
    });
  });
}

/**
 * Start the periodic polling loop (default 10 minutes).
 * Runs the helper immediately on first call, then repeats.
 */
export function startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  if (_pollTimer) return; // already started

  _exePath = findExePath();
  if (!_exePath) {
    log.warn("warframe-api-helper.exe not found — polling disabled");
    return;
  }

  log.log(`Starting helper polling every ${(intervalMs / 60_000).toFixed(0)} min`);

  // Run immediately, then on interval
  void runOnce();

  _pollTimer = setInterval(() => {
    void runOnce();
  }, intervalMs);
}

export function stopPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ── Download from GitHub Releases ──────────────────────────────────────────────

/** Simple wrapper around https.get that follows redirects and returns a Buffer. */
function httpsGetBuffer(
  url: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Stream-download a URL to a file, calling `onProgress` with byte counts.
 * Follows one redirect (GitHub asset URLs redirect to S3).
 */
function httpsDownloadToFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl: string, redirectsLeft: number) => {
      const mod = reqUrl.startsWith("https") ? https : http;
      mod
        .get(reqUrl, { headers: { "User-Agent": "warframe-companion" } }, (res) => {
          // Follow redirect
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume(); // drain
            doRequest(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          const total = parseInt(String(res.headers["content-length"] || "0"), 10);
          let received = 0;
          const fileStream = fs.createWriteStream(destPath);
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            onProgress(received, total);
          });
          res.pipe(fileStream);
          fileStream.on("finish", () => {
            fileStream.close();
            resolve();
          });
          fileStream.on("error", (err: Error) => {
            fs.unlink(destPath, () => {}); // clean up partial
            reject(err);
          });
          res.on("error", (err: Error) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        })
        .on("error", reject);
    };
    doRequest(url, 3);
  });
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

/**
 * Download the latest warframe-api-helper.exe from GitHub Releases.
 * Saves to `userData/api-helper/warframe-api-helper.exe`.
 * Calls `onProgress` with download progress updates.
 */
export async function downloadHelper(
  onProgress: (progress: DownloadProgress) => void,
): Promise<boolean> {
  try {
    onProgress({ stage: "resolving", percent: 0, bytesReceived: 0, bytesTotal: 0 });

    // 1. Fetch latest release metadata
    const releaseRes = await httpsGetBuffer(GITHUB_RELEASES_URL, {
      "User-Agent": "warframe-companion",
      Accept: "application/vnd.github+json",
    });

    if (releaseRes.statusCode !== 200) {
      throw new Error(`GitHub API returned ${releaseRes.statusCode}`);
    }

    const release: GitHubRelease = JSON.parse(releaseRes.body.toString("utf-8"));

    // 2. Find the .exe asset
    const exeAsset = release.assets.find(
      (a) => a.name.toLowerCase().endsWith(".exe"),
    );
    if (!exeAsset) {
      throw new Error("No .exe asset found in latest release");
    }

    log.log(`Downloading ${exeAsset.name} (${release.tag_name}, ${exeAsset.size} bytes)…`);

    // 3. Ensure target directory exists
    const helperDir = getHelperDir();
    fs.mkdirSync(helperDir, { recursive: true });

    const destPath = path.join(helperDir, EXE_NAME);
    const tempPath = destPath + ".tmp";

    // 4. Download the asset with progress
    onProgress({
      stage: "downloading",
      percent: 0,
      bytesReceived: 0,
      bytesTotal: exeAsset.size,
    });

    await httpsDownloadToFile(exeAsset.browser_download_url, tempPath, (received, total) => {
      const pct = total > 0 ? Math.round((received / total) * 100) : 0;
      onProgress({
        stage: "downloading",
        percent: pct,
        bytesReceived: received,
        bytesTotal: total || exeAsset.size,
      });
    });

    // 5. Atomically rename temp → final
    try {
      fs.unlinkSync(destPath);
    } catch {
      // fine if it doesn't exist yet
    }
    fs.renameSync(tempPath, destPath);

    // 6. Refresh cached exe path
    _exePath = destPath;

    log.log("Helper downloaded to:", destPath);
    onProgress({ stage: "done", percent: 100, bytesReceived: exeAsset.size, bytesTotal: exeAsset.size });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Helper download failed:", msg);
    onProgress({ stage: "error", percent: 0, bytesReceived: 0, bytesTotal: 0, error: msg });
    return false;
  }
}

/**
 * Initialise the runner: find the exe, cache its path.
 * Does NOT start polling yet — call startPolling() separately.
 */
export function init(): boolean {
  _exePath = findExePath();
  if (_exePath) {
    log.log("Found warframe-api-helper at:", _exePath);
  }
  return _exePath !== null;
}
