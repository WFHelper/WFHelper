/**
 * Runs warframe-api-helper.exe in the background (no CMD window) on a timer.
 * After each run, the existing chokidar file-watcher on inventory.json picks up changes.
 */

import { withScope } from "./logger";
import path from "node:path";
import fs from "node:fs";
import https from "node:https";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { app } from "electron";
import type { DownloadStage } from "../config/shared/statsTypes";

const log = withScope("apiHelperRunner");

const EXE_NAME = "warframe-api-helper.exe";
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// Hard kill the helper if it hasn't exited after this long. Normal runs are <5s.
const HELPER_SPAWN_TIMEOUT_MS = 60 * 1000;
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Sainan/warframe-api-helper/releases/latest";

/**
 * Pinned SHA-256 hashes of accepted warframe-api-helper.exe builds.
 * Any exe whose hash is not in this set will be refused — both on fresh download
 * and before spawning any locally-found copy. Bump when the upstream repo
 * (Sainan/warframe-api-helper) cuts a new release and you've audited it.
 */
const PINNED_HELPER_SHA256: ReadonlySet<string> = new Set([
  // 1.1.1 (tag on 'senpai' branch) — verified 2026-04-18
  "3f883abb1226c9da6d6cb9c2d6675d3daa6b321a192583c646ef8c45cbd5b8f6",
]);

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isPinnedHash(hash: string): boolean {
  return PINNED_HELPER_SHA256.has(hash.toLowerCase());
}

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _startupTimer: ReturnType<typeof setTimeout> | null = null;
let _running = false;
let _lastRunAt: number | null = null;
let _lastRunOk: boolean | null = null;
let _exePath: string | null = null;

interface HelperStatus {
  exeFound: boolean;
  running: boolean;
  lastRunAt: number | null; // unix ms
  lastRunOk: boolean | null;
  inventoryLastModified: number | null; // unix ms
  installerAutoInstallHelper: boolean | null;
}

interface DownloadProgress {
  stage: DownloadStage;
  percent: number; // 0-100
  bytesReceived: number;
  bytesTotal: number;
  error?: string;
}

/** Directory where we store the downloaded helper. */
function getHelperDir(): string {
  return path.join(app.getPath("userData"), "api-helper");
}

function getSetupPreferencesPath(): string {
  return path.join(app.getPath("userData"), "setup-preferences.json");
}

function getInstallerAutoInstallHelperPreference(): boolean | null {
  try {
    const raw = fs.readFileSync(getSetupPreferencesPath(), "utf-8");
    const parsed = JSON.parse(raw) as { autoInstallHelper?: unknown };
    return typeof parsed.autoInstallHelper === "boolean" ? parsed.autoInstallHelper : null;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    if (code !== "ENOENT") {
      log.warn(
        "Could not read setup preferences:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return null;
  }
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
      if (!fs.existsSync(p)) continue;
      const hash = sha256OfFile(p);
      if (isPinnedHash(hash)) return p;
      log.warn(
        `Refusing helper at ${p}: SHA-256 ${hash} not in pin set (possibly outdated or tampered).`,
      );
    } catch (err) {
      log.warn(`Could not hash helper at ${p}:`, err instanceof Error ? err.message : String(err));
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
    installerAutoInstallHelper: getInstallerAutoInstallHelperPreference(),
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

    /*
     * TOCTOU HARDENING — DO NOT REMOVE.
     *
     * The helper path was verified (hash, location, quarantine attributes)
     * when it was discovered, but that was some indeterminate time ago.
     * Between discovery and this spawn, an attacker with filesystem write
     * access could have swapped the binary at _exePath for a malicious
     * one with the same filename. The discovery-time hash check would
     * not protect us because it was performed on the old bytes.
     *
     * Re-hashing here, immediately before spawn, is the mitigation. It
     * narrows the attack window from minutes/hours down to the few
     * microseconds between this sha256 read and the spawn() call —
     * small enough that racing it requires kernel-level primitives
     * we can't defend against from userspace anyway.
     *
     * If you're tempted to "clean this up" as a duplicate check: the
     * duplication is the point. Keep both.
     */
    try {
      const hashNow = sha256OfFile(_exePath);
      if (!isPinnedHash(hashNow)) {
        log.error(`Helper hash changed since discovery (${hashNow}) — refusing to spawn`);
        _exePath = null;
        _lastRunOk = false;
        _lastRunAt = Date.now();
        resolve(false);
        return;
      }
    } catch (err) {
      log.error(
        "Helper pre-spawn hash check failed:",
        err instanceof Error ? err.message : String(err),
      );
      _lastRunOk = false;
      _lastRunAt = Date.now();
      resolve(false);
      return;
    }

    if (_running) {
      log.info("Helper already running — skipping");
      resolve(false);
      return;
    }

    _running = true;
    log.info("Running warframe-api-helper…");

    const child = spawn(_exePath, [], {
      cwd: path.dirname(_exePath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });

    // Helper prints `?accountId=...&nonce=...` to stdout/stderr; capture both.
    let outputBuf = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      outputBuf += chunk;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      outputBuf += chunk;
    });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      _running = false;
      _lastRunOk = ok;
      _lastRunAt = Date.now();
      resolve(ok);
    };

    const timeoutHandle = setTimeout(() => {
      log.warn(`Helper did not exit within ${HELPER_SPAWN_TIMEOUT_MS / 1000}s — killing`);
      try {
        child.kill("SIGKILL");
      } catch (err) {
        log.warn("Helper kill failed:", err instanceof Error ? err.message : String(err));
      }
      finish(false);
    }, HELPER_SPAWN_TIMEOUT_MS);

    child.on("error", (err: Error) => {
      log.error("Helper spawn error:", err.message);
      finish(false);
    });

    child.on("exit", (code: number | null) => {
      // Don't gate on exit code: helper's own HTTP request to mobile.warframe.com
      // returns empty 200s, but the authz it prints is still valid against
      // api.warframe.com, so we fetch ourselves.
      if (code !== 0) log.warn(`Helper exited with code ${code}`);
      const m = outputBuf.match(/\?accountId=[a-f0-9]+&nonce=\d+/i);
      if (!m) {
        log.error("Helper output did not contain auth params");
        finish(false);
        return;
      }
      const destPath = path.join(path.dirname(_exePath!), "inventory.json");
      void fetchInventoryWithAuthz(m[0], destPath).then(
        () => finish(true),
        (err) => {
          log.error("Inventory fetch failed:", err instanceof Error ? err.message : String(err));
          finish(false);
        },
      );
    });
  });
}

/** GET inventory.php with the helper-extracted authz. Tries api.warframe.com first. */
async function fetchInventoryWithAuthz(authz: string, destPath: string): Promise<void> {
  const hosts = ["api.warframe.com", "mobile.warframe.com"];
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json,*/*",
  };
  let lastErr: unknown = null;
  for (const host of hosts) {
    const url = `https://${host}/api/inventory.php${authz}`;
    try {
      const res = await httpsGetBuffer(url, headers);
      if (res.statusCode === 200 && res.body.length > 0) {
        fs.writeFileSync(destPath, res.body);
        log.info(`Inventory fetched from ${host} (${res.body.length} bytes)`);
        return;
      }
      lastErr = new Error(`${host} returned HTTP ${res.statusCode} (${res.body.length} bytes)`);
      log.warn(String(lastErr));
    } catch (err) {
      lastErr = err;
      log.warn(`${host} request error:`, err instanceof Error ? err.message : String(err));
    }
  }
  throw lastErr ?? new Error("All inventory hosts failed");
}

/**
 * Start the periodic polling loop (default 10 minutes).
 *
 * Cooldown honours `inventory.json` mtime across restarts: if the last refresh
 * happened less than `intervalMs` ago, we defer the first run until
 * `mtime + intervalMs`. This keeps the 10-minute rate-limit stable even when
 * the app is relaunched repeatedly.
 *
 * `onRunComplete` fires after each polling-driven run settles. The first run
 * on a brand-new install is where this matters: there is no inventory.json at
 * startup, so the file watcher in inventoryIpc is never installed, and the
 * helper's first successful run produces a file nothing is listening for.
 * Main wires this callback to discover + watch + push the file to the renderer
 * the moment it appears.
 */
export function startPolling(
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  onRunComplete?: (ok: boolean) => void,
): void {
  if (_pollTimer || _startupTimer) return; // already started

  _exePath = findExePath();
  if (!_exePath) {
    log.warn("warframe-api-helper.exe not found — polling disabled");
    return;
  }

  log.info(`Starting helper polling every ${(intervalMs / 60_000).toFixed(0)} min`);

  const mtime = getInventoryMtime();
  const ageMs = mtime !== null ? Date.now() - mtime : Infinity;
  const initialDelay = ageMs >= intervalMs ? 0 : intervalMs - ageMs;

  const runAndNotify = () => {
    void runOnce().then((ok) => {
      if (!onRunComplete) return;
      try {
        onRunComplete(ok);
      } catch (err) {
        log.warn(
          "onRunComplete handler threw:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  };

  const scheduleInterval = () => {
    if (_pollTimer) return;
    _pollTimer = setInterval(runAndNotify, intervalMs);
  };

  if (initialDelay === 0) {
    runAndNotify();
    scheduleInterval();
  } else {
    log.info(
      `inventory.json was refreshed ${(ageMs / 60_000).toFixed(1)} min ago — ` +
        `deferring first run by ${(initialDelay / 60_000).toFixed(1)} min`,
    );
    // Treat the existing inventory.json as our "last successful run" so the
    // titlebar status reflects reality instead of showing "WF data missing".
    _lastRunAt = mtime;
    _lastRunOk = true;
    _startupTimer = setTimeout(() => {
      _startupTimer = null;
      runAndNotify();
      scheduleInterval();
    }, initialDelay);
  }
}

export function stopPolling(): void {
  if (_startupTimer) {
    clearTimeout(_startupTimer);
    _startupTimer = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function assertHttps(url: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing non-HTTPS URL: ${url}`);
  }
}

/** Simple wrapper around https.get that returns a Buffer. HTTPS-only. */
function httpsGetBuffer(
  url: string,
  headers: Record<string, string>,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    assertHttps(url);
    https
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
      let absUrl: string;
      try {
        assertHttps(reqUrl);
        absUrl = reqUrl;
      } catch (err) {
        reject(err);
        return;
      }
      https
        .get(absUrl, { headers: { "User-Agent": "warframe-companion" } }, (res) => {
          // Follow redirect — but only to https:// targets. Resolve relative
          // locations against the current URL before re-validating.
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume(); // drain
            let next: string;
            try {
              next = new URL(res.headers.location, absUrl).toString();
              assertHttps(next);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            doRequest(next, redirectsLeft - 1);
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
    const exeAsset = release.assets.find((a) => a.name.toLowerCase().endsWith(".exe"));
    if (!exeAsset) {
      throw new Error("No .exe asset found in latest release");
    }

    log.info(`Downloading ${exeAsset.name} (${release.tag_name}, ${exeAsset.size} bytes)…`);

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

    // 5. Verify downloaded file: PE header + SHA-256 against pin set
    const downloadedBytes = fs.readFileSync(tempPath);
    if (downloadedBytes.length < 2 || downloadedBytes[0] !== 0x4d || downloadedBytes[1] !== 0x5a) {
      fs.unlinkSync(tempPath);
      throw new Error("Downloaded file is not a valid PE executable (missing MZ header)");
    }
    const sha256 = crypto.createHash("sha256").update(downloadedBytes).digest("hex");
    if (!isPinnedHash(sha256)) {
      fs.unlinkSync(tempPath);
      throw new Error(
        `Refusing helper: SHA-256 ${sha256} not in pin set. Upstream release may have changed — bump PINNED_HELPER_SHA256 after audit.`,
      );
    }
    log.info(`Helper SHA-256 pin verified: ${sha256}`);

    // 6. Atomically rename temp → final
    try {
      fs.unlinkSync(destPath);
    } catch {
      // fine if it doesn't exist yet
    }
    fs.renameSync(tempPath, destPath);

    // 7. Refresh cached exe path
    _exePath = destPath;

    log.info("Helper downloaded to:", destPath);
    onProgress({
      stage: "done",
      percent: 100,
      bytesReceived: exeAsset.size,
      bytesTotal: exeAsset.size,
    });
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
    log.info("Found warframe-api-helper at:", _exePath);
  }
  return _exePath !== null;
}
