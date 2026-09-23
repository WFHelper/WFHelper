import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { app } from "electron";

import type { HelperRunReason, HelperStatus } from "../config/shared/apiHelperTypes";
import type { DownloadStage } from "../config/shared/statsTypes";
import { readGameAuthz } from "./gameMemoryAuthz";
import { readGameAuthzWin } from "./gameMemoryWin";
import * as codexProfile from "./codexProfile";
import { resolveEeLogPath } from "./eeLogPath";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { getWarframeProcessState, isWarframeRunningCached } from "./warframeStatus";

const log = withScope("apiHelperRunner");

const IS_WINDOWS = process.platform === "win32";
// Upstream ships warframe-api-helper.exe for Windows and a Linux.zip holding a
// single `warframe-api-helper` ELF binary (works against the Proton game).
const EXE_NAME = IS_WINDOWS ? "warframe-api-helper.exe" : "warframe-api-helper";
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// Runs that failed before reaching DE's API (game closed, elevated, or not
// logged in) never consumed the cooldown, so they may retry much sooner.
const LOCAL_FAILURE_RETRY_MS = 90 * 1000;
// Hard kill the helper if it hasn't exited after this long. Normal runs are <5s.
const HELPER_SPAWN_TIMEOUT_MS = 60 * 1000;
const NETWORK_TIMEOUT_MS = 30_000;
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
// Real inventories are already ~0.9 MiB and only grow; keep this well above them.
const MAX_INVENTORY_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_HELPER_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const HELPER_RELEASE_TAG = "1.1.1";
const GITHUB_RELEASES_URL = `https://api.github.com/repos/Sainan/warframe-api-helper/releases/tags/${HELPER_RELEASE_TAG}`;

// Accepted helper binary SHA-256s; anything else is refused. Bump on a new audited release.
const PINNED_HELPER_SHA256: ReadonlySet<string> = new Set([
  // 1.1.1 (tag on 'senpai' branch) - verified 2026-04-18
  "3f883abb1226c9da6d6cb9c2d6675d3daa6b321a192583c646ef8c45cbd5b8f6",
  // 1.1.1 Linux.zip inner `warframe-api-helper` ELF - user-approved pin 2026-07-21
  "971b9c00cb95a8cabfc0c3f2ce9d6422f6380c3d83dc380fb9a9df18535b1a5a",
]);

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Extract the single-file Linux archive without a zip dependency. */
export function extractSingleZipEntry(zip: Buffer): Buffer {
  let eocd = -1;
  const scanFloor = Math.max(0, zip.length - 22 - 65_535);
  for (let i = zip.length - 22; i >= scanFloor; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory not found");
  const entryCount = zip.readUInt16LE(eocd + 10);
  if (entryCount !== 1) throw new Error(`zip: expected exactly 1 entry, got ${entryCount}`);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("zip: bad central directory");
  const method = zip.readUInt16LE(cdOffset + 10);
  const compressedSize = zip.readUInt32LE(cdOffset + 20);
  const localOffset = zip.readUInt32LE(cdOffset + 42);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip: bad local header");
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${method}`);
}

function isPinnedHash(hash: string): boolean {
  return PINNED_HELPER_SHA256.has(hash.toLowerCase());
}

let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _startupTimer: ReturnType<typeof setTimeout> | null = null;
let _loginRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _pollingActive = false;
let _running = false;
let _lastRunAt: number | null = null;
let _lastRunOk: boolean | null = null;
let _lastRunReason: HelperRunReason | null = null;
let _exePath: string | null = null;
let _runAndNotify: (() => void) | null = null;
let _waitingForGame = false;

/** Only a sample that answered counts; unknown still runs the helper. */
function gameKnownClosed(): boolean {
  return (IS_WINDOWS ? getWarframeProcessState() : isWarframeRunningCached()) === false;
}

function settleRun(ok: boolean, reason: HelperRunReason | null = null): boolean {
  _running = false;
  _lastRunOk = ok;
  _lastRunReason = ok ? null : (reason ?? "error");
  _lastRunAt = Date.now();
  return ok;
}

/** Sainan's helper: 1 = game not found, 2 = OpenProcess denied (game runs as
 *  admin), 3 = auth string not in memory (login screen). */
export function helperFailureReason(exitCode: number | null): HelperRunReason {
  if (exitCode === 1) return "game-not-running";
  if (exitCode === 2) return "access-denied";
  if (exitCode === 3) return "not-logged-in";
  return "error";
}

/** Fast retry only for failures that resolve on their own within minutes;
 *  token-not-found is persistent and a rescan hits gigabytes of game memory. */
export function nextHelperPollDelayMs(
  ok: boolean,
  reason: HelperRunReason | null,
  intervalMs: number,
): number {
  if (reason === "game-not-running" || reason === "access-denied" || reason === "not-logged-in") {
    return Math.min(LOCAL_FAILURE_RETRY_MS, intervalMs);
  }
  return intervalMs;
}

export function shouldRetryAfterGameLogin(
  running: boolean,
  lastRunOk: boolean | null,
  reason: HelperRunReason | null,
): boolean {
  if (running) return true;
  if (lastRunOk === true) return false;
  return (
    reason === null ||
    reason === "game-not-running" ||
    reason === "not-logged-in" ||
    reason === "token-not-found" ||
    reason === "error"
  );
}

/** EE.log logs "Logging in as <name>" once the session is authenticated
 *  (AlecaFrame uses the same marker), and is recreated on game start. */
const EE_LOG_LOGIN_MARKER = "Logging in as ";

/** Chunked substring scan so a large EE.log never sits in memory at once. */
export async function fileContainsMarker(
  filePath: string,
  marker: string,
  chunkSize = 4 * 1024 * 1024,
): Promise<boolean> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, "r");
    const buf = Buffer.alloc(chunkSize);
    let carry = "";
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead <= 0) return false;
      const text = carry + buf.toString("utf8", 0, bytesRead);
      if (text.includes(marker)) return true;
      carry = text.slice(-marker.length);
    }
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Exit 3 conflates "at the login screen" with "logged in but the token scan
 *  failed"; EE.log tells the two apart. */
async function classifyNotLoggedIn(): Promise<HelperRunReason> {
  const eeLogPath = resolveEeLogPath();
  if (!eeLogPath) return "not-logged-in";
  const loggedIn = await fileContainsMarker(eeLogPath, EE_LOG_LOGIN_MARKER);
  return loggedIn ? "token-not-found" : "not-logged-in";
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
  return userDataPath("api-helper");
}

function getSetupPreferencesPath(): string {
  return userDataPath("setup-preferences.json");
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

// Keep helper-produced and compatibility JSON at the same watched path.
function getInventoryDir(): string {
  return _exePath ? path.dirname(_exePath) : getHelperDir();
}

function getInventoryTargetPath(): string {
  return path.join(getInventoryDir(), "inventory.json");
}

function getInventoryMtime(): number | null {
  const dir = getInventoryDir();
  if (!dir) return null;
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
    // Linux reads game memory directly, so the "helper" is always available.
    exeFound: IS_WINDOWS ? _exePath !== null : true,
    running: _running,
    lastRunAt: _lastRunAt,
    lastRunOk: _lastRunOk,
    lastRunReason: _lastRunReason,
    inventoryLastModified: getInventoryMtime(),
    installerAutoInstallHelper: getInstallerAutoInstallHelperPreference(),
  };
}

/** Run the helper without showing a console window. */
// Linux: skip the external ELF entirely - read the auth query from game memory
// and reuse the same inventory fetch as Windows.
async function runOnceLinux(): Promise<boolean> {
  _running = true;
  log.info("Reading inventory auth from game memory...");

  const result = await readGameAuthz().catch((err) => {
    log.error("Game memory read failed:", err instanceof Error ? err.message : String(err));
    return null;
  });

  if (!result?.authz) {
    if (result?.reason === "process-not-found") {
      log.warn("Warframe is not running - start the game and log in first.");
      return settleRun(false, "game-not-running");
    }
    if (result?.reason.startsWith("mem-open-")) {
      log.error(
        `Cannot read game memory (${result.reason}). Set kernel.yama.ptrace_scope=0, ` +
          "or grant cap_sys_ptrace (see the Linux notes in the release).",
      );
      return settleRun(false, "access-denied");
    }
    log.warn("Auth params not in game memory - are you logged in and in your Orbiter?");
    return settleRun(false, await classifyNotLoggedIn());
  }

  log.info(`Auth acquired from game memory (${result.reason})`);
  const dir = getHelperDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // dir already exists or cannot be created - fetch will surface any write error
  }
  try {
    await fetchInventoryWithAuthz(result.authz, path.join(dir, "inventory.json"));
    return settleRun(true);
  } catch (err) {
    log.error("Inventory fetch failed:", err instanceof Error ? err.message : String(err));
    return settleRun(false);
  }
}

export function runOnce(): Promise<boolean> {
  if (_running) return Promise.resolve(false);
  if (!IS_WINDOWS) return runOnceLinux();
  return runOnceWindows();
}

export function shouldUseWindowsNativeFallback(
  helperFound: boolean,
  reason: HelperRunReason | null,
): boolean {
  return !helperFound || reason === "token-not-found" || reason === "error";
}

async function runOnceWindows(): Promise<boolean> {
  _running = true;

  if (!_exePath) _exePath = findExePath();
  const helperFound = _exePath !== null;
  if (helperFound) {
    const helper = await runHelperExe();
    if (helper.ok || !shouldUseWindowsNativeFallback(true, helper.reason)) {
      return settleRun(helper.ok, helper.reason);
    }
    log.warn("Helper did not find the login token - trying the one-match compatibility scan");
  }

  const native = await readGameAuthzWin().catch((err) => {
    log.warn("Native game-memory scan failed:", err instanceof Error ? err.message : String(err));
    return null;
  });

  if (native?.authz) {
    log.info(`Auth acquired from game memory (${native.reason})`);
    try {
      const dest = getInventoryTargetPath();
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await fetchInventoryWithAuthz(native.authz, dest);
      return settleRun(true);
    } catch (err) {
      log.error("Inventory fetch failed:", err instanceof Error ? err.message : String(err));
      return settleRun(false, "api-failed");
    }
  }

  const reason = native ? await nativeAuthzReason(native.reason) : "error";
  if (reason === "access-denied") {
    log.error(
      "Warframe is likely running as administrator - WFHelper cannot read an " +
        "elevated game. Restart Warframe without admin rights.",
    );
  }
  if (reason === "token-not-found") {
    log.error(
      "EE.log shows a login, so the game is running and logged in - the auth " +
        "token just was not found in game memory.",
    );
  }
  return settleRun(false, reason);
}

async function nativeAuthzReason(reason: string): Promise<HelperRunReason> {
  if (reason === "process-not-found") return "game-not-running";
  if (reason.startsWith("mem-open-")) {
    // GetLastError 5 = ERROR_ACCESS_DENIED (game elevated); else unexpected.
    return reason === "mem-open-5" ? "access-denied" : "error";
  }
  // A readable scan yielded no safe token; EE.log distinguishes the login screen
  // from a missed or ambiguous match.
  return classifyNotLoggedIn();
}

// Spawn the bundled helper exe once and resolve its outcome. The caller owns
// _running and the last-run state; this only reports {ok, reason}.
function runHelperExe(): Promise<{ ok: boolean; reason: HelperRunReason | null }> {
  return new Promise((resolve) => {
    if (!_exePath) {
      _exePath = findExePath();
    }
    if (!_exePath) {
      log.warn(`${EXE_NAME} not found - no exe fallback available`);
      resolve({ ok: false, reason: "error" });
      return;
    }

    // Re-hash at spawn time to close the TOCTOU gap after discovery validation.
    // The duplicate check is intentional; do not remove it.
    try {
      const hashNow = sha256OfFile(_exePath);
      if (!isPinnedHash(hashNow)) {
        log.error(`Helper hash changed since discovery (${hashNow}) - refusing to spawn`);
        _exePath = null;
        resolve({ ok: false, reason: "error" });
        return;
      }
    } catch (err) {
      log.error(
        "Helper pre-spawn hash check failed:",
        err instanceof Error ? err.message : String(err),
      );
      resolve({ ok: false, reason: "error" });
      return;
    }

    log.info("Running warframe-api-helper...");
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
    const finish = (ok: boolean, reason: HelperRunReason | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ ok, reason: ok ? null : (reason ?? "error") });
    };

    const timeoutHandle = setTimeout(() => {
      log.warn(`Helper did not exit within ${HELPER_SPAWN_TIMEOUT_MS / 1000}s - killing`);
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
      // The helper can print valid auth after its own mobile API request fails.
      if (code !== 0) log.warn(`Helper exited with code ${code}`);
      const m = outputBuf.match(/\?accountId=[a-f0-9]+&nonce=\d+/i);
      if (!m) {
        const mapped = helperFailureReason(code);
        const reasonPromise =
          mapped === "not-logged-in" ? classifyNotLoggedIn() : Promise.resolve(mapped);
        void reasonPromise.then((reason) => {
          log.error(`Helper output did not contain auth params (${reason})`);
          if (reason === "access-denied") {
            log.error(
              "Warframe is likely running as administrator - WFHelper cannot read " +
                "an elevated game. Restart Warframe without admin rights.",
            );
          }
          if (reason === "token-not-found") {
            log.error(
              "EE.log shows a login, so the game is running and logged in - the " +
                "auth token just was not found in game memory.",
            );
          }
          finish(false, reason);
        });
        return;
      }
      const dest = getInventoryTargetPath();
      void fetchInventoryWithAuthz(m[0], dest).then(
        () => finish(true),
        (err) => {
          log.error("Inventory fetch failed:", err instanceof Error ? err.message : String(err));
          finish(false, "api-failed");
        },
      );
    });
  });
}

/** GET inventory.php with the helper-extracted authz. Tries api.warframe.com first. */
async function fetchInventoryWithAuthz(authz: string, destPath: string): Promise<void> {
  codexProfile.noteAuthz(authz);
  const hosts = ["api.warframe.com", "mobile.warframe.com"];
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json,*/*",
  };
  let lastErr: unknown = null;
  for (const host of hosts) {
    const url = `https://${host}/api/inventory.php${authz}`;
    try {
      const res = await httpsGetBuffer(url, headers, MAX_INVENTORY_RESPONSE_BYTES);
      if (res.statusCode === 200 && res.body.length > 0) {
        codexProfile.noteInventorySnapshot(authz, res.body);
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

/** Preserve the inventory mtime cooldown across restarts.
 * `onRunComplete` lets first-run installs attach their initially absent file. */
export function startPolling(
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  onRunComplete?: (ok: boolean) => void,
): void {
  // The chained timeouts leave both timer handles null while a run is in
  // flight, so the timers alone cannot guard against a second chain.
  if (_pollingActive) return;

  if (IS_WINDOWS) {
    _exePath = findExePath();
    if (!_exePath) {
      log.warn(`${EXE_NAME} not found - using the one-match compatibility scan`);
    }
  } else {
    log.info("Linux: inventory read directly from game memory (no external helper).");
  }
  _pollingActive = true;

  log.info(`Starting helper polling every ${(intervalMs / 60_000).toFixed(0)} min`);

  const mtime = getInventoryMtime();
  const ageMs = mtime !== null ? Date.now() - mtime : Infinity;
  const initialDelay = ageMs >= intervalMs ? 0 : intervalMs - ageMs;

  const scheduleNext = () => {
    if (!_pollingActive || _pollTimer) return;
    const delay = nextHelperPollDelayMs(_lastRunOk === true, _lastRunReason, intervalMs);
    if (delay < intervalMs && !_waitingForGame) {
      log.info(
        `Last run failed before reaching the API (${_lastRunReason}) - ` +
          `retrying in ${Math.round(delay / 1000)}s`,
      );
    }
    _pollTimer = setTimeout(() => {
      _pollTimer = null;
      runScheduled();
    }, delay);
  };

  const runAndNotify = () => {
    _waitingForGame = false;
    void runOnce().then((ok) => {
      try {
        onRunComplete?.(ok);
      } catch (err) {
        log.warn("onRunComplete handler threw:", err instanceof Error ? err.message : String(err));
      }
      scheduleNext();
    });
  };
  _runAndNotify = runAndNotify;

  // Settles exactly as the helper's own exit 1 would, so a later login still
  // gets its fast fetch; only the spawn is saved.
  const runScheduled = () => {
    if (_running || !gameKnownClosed()) {
      runAndNotify();
      return;
    }
    if (!_waitingForGame) log.info("Warframe is not running - helper runs wait for the game");
    _waitingForGame = true;
    settleRun(false, "game-not-running");
    scheduleNext();
  };

  if (initialDelay === 0) {
    runScheduled();
  } else {
    log.info(
      `inventory.json was refreshed ${(ageMs / 60_000).toFixed(1)} min ago - ` +
        `deferring first run by ${(initialDelay / 60_000).toFixed(1)} min`,
    );
    // Treat the existing inventory.json as our "last successful run" so the
    // titlebar status reflects reality instead of showing "WF data missing".
    _lastRunAt = mtime;
    _lastRunOk = true;
    _startupTimer = setTimeout(() => {
      _startupTimer = null;
      runScheduled();
    }, initialDelay);
  }
}

export function runAfterGameLogin(): void {
  if (
    !_pollingActive ||
    _loginRetryTimer ||
    !shouldRetryAfterGameLogin(_running, _lastRunOk, _lastRunReason)
  ) {
    return;
  }

  const retry = () => {
    _loginRetryTimer = null;
    if (!_pollingActive || !shouldRetryAfterGameLogin(_running, _lastRunOk, _lastRunReason)) return;
    if (_running) {
      _loginRetryTimer = setTimeout(retry, 250);
      return;
    }
    if (_startupTimer) {
      clearTimeout(_startupTimer);
      _startupTimer = null;
    }
    if (_pollTimer) {
      clearTimeout(_pollTimer);
      _pollTimer = null;
    }
    log.info("Warframe login completed - retrying inventory helper");
    _runAndNotify?.();
  };

  _loginRetryTimer = setTimeout(retry, 250);
}

export function stopPolling(): void {
  _pollingActive = false;
  _runAndNotify = null;
  _waitingForGame = false;
  if (_startupTimer) {
    clearTimeout(_startupTimer);
    _startupTimer = null;
  }
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  if (_loginRetryTimer) {
    clearTimeout(_loginRetryTimer);
    _loginRetryTimer = null;
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
  maxBytes: number,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    assertHttps(url);
    const request = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.destroy(new Error(`Response exceeded ${maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", reject);
    });
    request.setTimeout(NETWORK_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", reject);
  });
}

/** Stream a download to disk and follow one GitHub asset redirect. */
function httpsDownloadToFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const doRequest = (reqUrl: string, redirectsLeft: number) => {
      let absUrl: string;
      try {
        assertHttps(reqUrl);
        absUrl = reqUrl;
      } catch (err) {
        rejectOnce(err);
        return;
      }
      const request = https.get(absUrl, { headers: { "User-Agent": "WFHelper" } }, (res) => {
        // Follow redirect - but only to https:// targets. Resolve relative
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
            rejectOnce(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          doRequest(next, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          rejectOnce(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(String(res.headers["content-length"] || "0"), 10);
        if (total > MAX_HELPER_DOWNLOAD_BYTES) {
          res.resume();
          rejectOnce(new Error("Helper download exceeded 128 MiB"));
          return;
        }
        let received = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_HELPER_DOWNLOAD_BYTES) {
            res.destroy(new Error("Helper download exceeded 128 MiB"));
            fileStream.destroy();
            fs.unlink(destPath, () => {});
            return;
          }
          onProgress(received, total);
        });
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolveOnce();
        });
        fileStream.on("error", (err: Error) => {
          fs.unlink(destPath, () => {}); // clean up partial
          rejectOnce(err);
        });
        res.on("error", (err: Error) => {
          fs.unlink(destPath, () => {});
          rejectOnce(err);
        });
      });
      request.setTimeout(NETWORK_TIMEOUT_MS, () => {
        request.destroy(new Error("Helper download timed out"));
      });
      request.on("error", rejectOnce);
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

/** Download the pinned helper binary into userData. */
export async function downloadHelper(
  onProgress: (progress: DownloadProgress) => void,
): Promise<boolean> {
  try {
    onProgress({ stage: "resolving", percent: 0, bytesReceived: 0, bytesTotal: 0 });

    const releaseRes = await httpsGetBuffer(
      GITHUB_RELEASES_URL,
      { "User-Agent": "WFHelper", Accept: "application/vnd.github+json" },
      MAX_RELEASE_METADATA_BYTES,
    );

    if (releaseRes.statusCode !== 200) {
      throw new Error(`GitHub API returned ${releaseRes.statusCode}`);
    }

    const release: GitHubRelease = JSON.parse(releaseRes.body.toString("utf-8"));

    const exeAsset = IS_WINDOWS
      ? release.assets.find((a) => a.name.toLowerCase().endsWith(".exe"))
      : release.assets.find(
          (a) => a.name.toLowerCase().startsWith("linux") && a.name.toLowerCase().endsWith(".zip"),
        );
    if (!exeAsset) {
      throw new Error(`No ${IS_WINDOWS ? ".exe" : "Linux .zip"} asset found in release`);
    }

    log.info(`Downloading ${exeAsset.name} (${release.tag_name}, ${exeAsset.size} bytes)...`);

    const helperDir = getHelperDir();
    fs.mkdirSync(helperDir, { recursive: true });

    const destPath = path.join(helperDir, EXE_NAME);
    const tempPath = destPath + ".tmp";

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

    // Validate the extracted executable against the same pin used at launch.
    let binaryBytes: Buffer = fs.readFileSync(tempPath);
    if (!IS_WINDOWS) binaryBytes = extractSingleZipEntry(binaryBytes);
    const magicOk = IS_WINDOWS
      ? binaryBytes.length >= 2 && binaryBytes[0] === 0x4d && binaryBytes[1] === 0x5a
      : binaryBytes.length >= 4 && binaryBytes.readUInt32BE(0) === 0x7f454c46;
    if (!magicOk) {
      fs.unlinkSync(tempPath);
      throw new Error(
        IS_WINDOWS
          ? "Downloaded file is not a valid PE executable (missing MZ header)"
          : "Downloaded file is not a valid ELF executable",
      );
    }
    const sha256 = crypto.createHash("sha256").update(binaryBytes).digest("hex");
    if (!isPinnedHash(sha256)) {
      fs.unlinkSync(tempPath);
      throw new Error(
        `Refusing helper: SHA-256 ${sha256} not in pin set. Upstream release may have changed - bump PINNED_HELPER_SHA256 after audit.`,
      );
    }
    log.info(`Helper SHA-256 pin verified: ${sha256}`);

    // atomic swap into place (on linux the temp file holds zip bytes; replace
    // them with the extracted binary and make it executable first)
    if (!IS_WINDOWS) {
      fs.writeFileSync(tempPath, Buffer.from(binaryBytes));
      fs.chmodSync(tempPath, 0o755);
    }
    try {
      fs.unlinkSync(destPath);
    } catch {
      // fine if it doesn't exist yet
    }
    fs.renameSync(tempPath, destPath);

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

export function init(): boolean {
  _exePath = findExePath();
  if (_exePath) {
    log.info("Found warframe-api-helper at:", _exePath);
  }
  return _exePath !== null;
}
