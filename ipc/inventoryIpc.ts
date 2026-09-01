import ctx from "./context";
import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { hasInventoryShape, unwrapInventoryPayload } from "../config/shared/inventoryPayload";
import { withScope } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  INVENTORY_GET,
  INVENTORY_OPEN_ALECA_FRAME_FILE,
  INVENTORY_OPEN_FILE,
  INVENTORY_GET_STATUS,
  INVENTORY_SET_SOURCE,
  INVENTORY_STATUS_UPDATED,
  INVENTORY_UPDATED,
} from "../config/shared/ipcChannels";
import {
  DEFAULT_INVENTORY_SOURCE,
  normalizeInventorySource,
  type InventorySource,
} from "../config/shared/inventorySource";
import { readAlecaFrameInventoryFile } from "../services/alecaFrameInventory";
import { userDataPath } from "../services/userDataPath";
import * as inventorySync from "../services/inventorySync";
import { dialog, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { writeFileAtomicSync } from "../services/atomicFile";
import { sendToPopouts } from "./popoutIpc";
import chokidar from "chokidar";
import crypto from "node:crypto";

const log = withScope("inventoryIpc");

const HELPER_INVENTORY_DIRECTORIES = [userDataPath("api-helper")];

const USER_INVENTORY_DIRECTORIES = [
  app.getPath("downloads"),
  app.getPath("desktop"),
  app.getPath("documents"),
  app.getPath("home"),
  app.getPath("userData"),
];

const DEV_FALLBACK_INVENTORY_DIRECTORIES = [
  process.cwd(),
  path.join(process.cwd(), "api-inventory-data"),
];

const INVENTORY_FILENAME_RE = /^inventory(?:_[^\\/:*?"<>|]+)?\.json$/i;

const INVENTORY_WATCH_STABILITY_MS = 500;
const INVENTORY_WATCH_RETRY_MS = 2_000;
const MAX_INVENTORY_BYTES = 50 * 1024 * 1024;
const JSON_ENCODING = "utf-8";

let _lastInventoryHash: string | null = null;
let _lastListenerInventoryHash: string | null = null;
let _trustedInventoryPath: string | null = null;
/** Sources that read plain inventory JSON; only their acquisition differs. */
type JsonInventorySource = Exclude<InventorySource, "aleca">;
let _trustedInventorySource: InventorySource = DEFAULT_INVENTORY_SOURCE;
let _activeInventorySource: InventorySource = DEFAULT_INVENTORY_SOURCE;
let _loadedInventoryModifiedAt: number | null = null;
let _watchGeneration = 0;
let _watchRetryTimer: ReturnType<typeof setTimeout> | null = null;

interface InventoryReadError {
  kind: "parse" | "read" | "watch";
  message: string;
  path: string;
  at: number;
}

const FS_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EISDIR",
  "ENOTDIR",
  "EMFILE",
  "ENFILE",
  "ELOOP",
  "ENAMETOOLONG",
]);

// A permissions or missing-file failure reported as "failed to parse" sends
// every bug report down the wrong path.
function inventoryErrorKind(err: unknown): "parse" | "read" {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && FS_ERROR_CODES.has(code) ? "read" : "parse";
}
let _lastReadError: InventoryReadError | null = null;

const _inventoryStatePath = userDataPath("inventory-reload-state.json");

function _loadPersistedState(): void {
  try {
    const raw = fs.readFileSync(_inventoryStatePath, JSON_ENCODING);
    const data = JSON.parse(raw) as {
      hash?: string;
      inventoryPath?: string;
      inventorySource?: string;
    };
    if (typeof data.hash === "string") _lastInventoryHash = data.hash;
    if (typeof data.inventoryPath === "string") _trustedInventoryPath = data.inventoryPath;
    _trustedInventorySource = normalizeInventorySource(data.inventorySource);
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    if (code !== "ENOENT") {
      log.debug(
        "[Inventory] persisted reload state missing or corrupt; starting fresh:",
        normalizeErrorMessage(err),
      );
    }
    // missing or corrupt - start fresh
  }
}

function _persistState(): void {
  try {
    writeFileAtomicSync(
      _inventoryStatePath,
      JSON.stringify({
        hash: _lastInventoryHash,
        inventoryPath: _trustedInventoryPath,
        inventorySource: _trustedInventorySource,
      }),
    );
  } catch (err) {
    log.debug("[Inventory] failed to persist reload state:", normalizeErrorMessage(err));
    // best-effort
  }
}

_loadPersistedState();

type InventoryDataListener = (data: Record<string, unknown>) => void;
const _inventoryListeners: InventoryDataListener[] = [];

/** Subscribes to inventory reads and returns an unsubscribe function. */
export function addInventoryListener(fn: InventoryDataListener): () => void {
  _inventoryListeners.push(fn);
  return () => {
    const idx = _inventoryListeners.indexOf(fn);
    if (idx >= 0) _inventoryListeners.splice(idx, 1);
  };
}

function _notifyListeners(data: Record<string, unknown>): void {
  for (const fn of _inventoryListeners) {
    try {
      fn(data);
    } catch (err) {
      log.warn(`[InventoryIpc] Inventory listener threw:`, err);
    }
  }
}

function _notifyListenersOncePerProcessHash(hash: string, data: unknown): void {
  if (!data || typeof data !== "object") return;
  if (hash === _lastListenerInventoryHash) return;
  _lastListenerInventoryHash = hash;
  _notifyListeners(data as Record<string, unknown>);
}

function getInventoryStatus(): {
  path: string | null;
  found: boolean;
  source: InventorySource;
  modifiedAt: number | null;
  lastError: InventoryReadError | null;
} {
  return {
    path: ctx.currentInventoryPath,
    found: ctx.currentInventoryPath !== null,
    source: _trustedInventorySource,
    modifiedAt: getLoadedInventoryModifiedAt(),
    lastError: _lastReadError,
  };
}

function notifyInventoryStatus(): void {
  const window = ctx.mainWindow;
  if (!window || window.isDestroyed()) return;
  window.webContents.send(INVENTORY_STATUS_UPDATED, getInventoryStatus());
}

function newestExistingInventoryPath(paths: string[]): string | null {
  let bestPath: string | null = null;
  let bestMtimeMs = -1;

  for (const filePath of paths) {
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_INVENTORY_BYTES) {
        log.warn(`Ignoring inventory candidate over 50 MB: ${filePath}`);
        continue;
      }
      if (stats.mtimeMs > bestMtimeMs) {
        bestMtimeMs = stats.mtimeMs;
        bestPath = filePath;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }

  return bestPath;
}

function rememberInventoryPath(filePath: string, source: InventorySource): void {
  if (_trustedInventoryPath === filePath && _trustedInventorySource === source) return;
  _trustedInventoryPath = filePath;
  _trustedInventorySource = source;
  _persistState();
}

function listInventoryJsonFiles(directoryPath: string): string[] {
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && INVENTORY_FILENAME_RE.test(entry.name))
      .map((entry) => path.join(directoryPath, entry.name));
  } catch {
    return [];
  }
}

function collectInventoryCandidates(directories: string[]): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directoryPath of directories) {
    for (const candidatePath of listInventoryJsonFiles(directoryPath)) {
      if (seen.has(candidatePath)) continue;
      seen.add(candidatePath);
      candidates.push(candidatePath);
    }
  }
  return candidates;
}

function findInventoryFile(): string | null {
  // newest wins between helper output and the last import - a stale helper
  // snapshot must not shadow a fresher manually imported file
  const primaryCandidates = collectInventoryCandidates(HELPER_INVENTORY_DIRECTORIES);
  if (_trustedInventoryPath && _trustedInventorySource !== "aleca") {
    primaryCandidates.push(_trustedInventoryPath);
  }
  const primaryCandidate = newestExistingInventoryPath(primaryCandidates);
  if (primaryCandidate) return primaryCandidate;

  const userCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(USER_INVENTORY_DIRECTORIES),
  );
  if (userCandidate) {
    log.warn("Using inventory file discovered from user-writable folders:", userCandidate);
    return userCandidate;
  }

  // NODE_ENV is unset in packaged builds; isPackaged is the reliable signal
  const allowDevFallback = !app.isPackaged;
  if (!allowDevFallback) return null;

  const devCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(DEV_FALLBACK_INVENTORY_DIRECTORIES),
  );
  if (devCandidate) {
    log.warn("Using development fallback inventory file:", devCandidate);
  }
  return devCandidate;
}

interface InventoryFileSnapshot {
  raw: string;
  modifiedAt: number;
}

function readInventorySnapshot(filePath: string): InventoryFileSnapshot | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      _lastReadError = {
        kind: "read",
        message: "Inventory path is not a file",
        path: filePath,
        at: Date.now(),
      };
      return null;
    }
    if (stats.size > MAX_INVENTORY_BYTES) {
      const message = `Inventory file exceeds ${MAX_INVENTORY_BYTES} byte limit`;
      log.warn(`Refusing inventory at ${filePath}: ${message}`);
      _lastReadError = { kind: "read", message, path: filePath, at: Date.now() };
      return null;
    }
    return {
      raw: fs.readFileSync(filePath, JSON_ENCODING),
      modifiedAt: stats.mtimeMs,
    };
  } catch (err) {
    const message = normalizeErrorMessage(err);
    log.error(`Failed to read inventory at ${filePath}:`, message);
    _lastReadError = { kind: "read", message, path: filePath, at: Date.now() };
    return null;
  }
}

function parseInventoryRaw(raw: string): unknown {
  const data = unwrapInventoryPayload(JSON.parse(raw), {
    onParseError: (err: unknown) =>
      log.warn("Failed to parse nested inventory payload string:", normalizeErrorMessage(err)),
  });
  if (!hasInventoryShape(data)) {
    throw new Error("Inventory JSON does not contain expected inventory arrays");
  }
  return data;
}

function readInventory(filePath: string, source: JsonInventorySource = "helper"): unknown {
  const snapshot = readInventorySnapshot(filePath);
  if (snapshot == null) return null;

  let data: unknown;
  try {
    const hash = crypto.createHash("sha256").update(snapshot.raw).digest("hex");
    const contentUnchanged = hash === _lastInventoryHash;

    // Startup reads must populate the UI even when the persisted hash matches.
    data = parseInventoryRaw(snapshot.raw);
    ctx.currentInventoryData = data as Record<string, unknown> | null;
    _loadedInventoryModifiedAt = snapshot.modifiedAt;
    _lastReadError = null;
    _activeInventorySource = source;
    rememberInventoryPath(filePath, source);

    _notifyListenersOncePerProcessHash(hash, data);

    if (contentUnchanged) return data;

    _lastInventoryHash = hash;
    _persistState();
    return data;
  } catch (err) {
    const message = normalizeErrorMessage(err);
    const kind = inventoryErrorKind(err);
    log.error(`Failed to ${kind} inventory at ${filePath}:`, message);
    _lastReadError = { kind, message, path: filePath, at: Date.now() };
    return null;
  }
}

function readAlecaFrameInventory(filePath: string): unknown {
  try {
    const modifiedAt = fs.statSync(filePath).mtimeMs;
    const data = readAlecaFrameInventoryFile(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    ctx.currentInventoryData = data as Record<string, unknown> | null;
    _loadedInventoryModifiedAt = modifiedAt;
    _lastReadError = null;
    _lastInventoryHash = hash;
    _activeInventorySource = "aleca";
    ctx.currentInventoryPath = filePath;
    rememberInventoryPath(filePath, "aleca");
    _persistState();
    _notifyListenersOncePerProcessHash(hash, data);
    return data;
  } catch (err) {
    const message = normalizeErrorMessage(err);
    const kind = inventoryErrorKind(err);
    log.error(`Failed to ${kind} AlecaFrame inventory at ${filePath}:`, message);
    _lastReadError = { kind, message, path: filePath, at: Date.now() };
    return null;
  }
}

function watchInventoryFile(filePath: string, source: InventorySource = "helper"): void {
  stopInventoryWatcher();
  const generation = _watchGeneration;
  ctx.currentInventoryPath = filePath;
  _activeInventorySource = source;

  const watcher = chokidar.watch(filePath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: INVENTORY_WATCH_STABILITY_MS },
  });
  ctx.watcher = watcher;

  watcher.on("change", () => {
    if (generation !== _watchGeneration) return;
    if (source === "aleca") {
      const previousHash = _lastInventoryHash;
      const data = readAlecaFrameInventory(filePath);
      if (!data || _lastInventoryHash === previousHash) return;
      if (ctx.mainWindow) ctx.mainWindow.webContents.send(INVENTORY_UPDATED, data);
      sendToPopouts(INVENTORY_UPDATED, data);
      return;
    }
    const snapshot = readInventorySnapshot(filePath);
    if (snapshot == null) return;

    const hash = crypto.createHash("sha256").update(snapshot.raw).digest("hex");
    if (hash === _lastInventoryHash) {
      _loadedInventoryModifiedAt = snapshot.modifiedAt;
      log.info("Inventory file touched but content unchanged, skipping reload.");
      return;
    }

    try {
      const data = parseInventoryRaw(snapshot.raw);
      _lastInventoryHash = hash;
      _persistState();
      log.info("Inventory file changed, reloading...");
      ctx.currentInventoryData = data as Record<string, unknown> | null;
      _loadedInventoryModifiedAt = snapshot.modifiedAt;
      _lastReadError = null;
      rememberInventoryPath(filePath, source);
      _notifyListenersOncePerProcessHash(hash, data);
      if (data && ctx.mainWindow) {
        ctx.mainWindow.webContents.send(INVENTORY_UPDATED, data);
      }
      if (data) sendToPopouts(INVENTORY_UPDATED, data);
    } catch (err) {
      const message = normalizeErrorMessage(err);
      const kind = inventoryErrorKind(err);
      log.error(`Failed to ${kind} inventory:`, message);
      _lastReadError = { kind, message, path: filePath, at: Date.now() };
    }
  });

  watcher.on("error", (error) => {
    if (generation !== _watchGeneration) return;
    const message = normalizeErrorMessage(error);
    log.error(`Inventory watcher failed for ${filePath}:`, message);
    _lastReadError = { kind: "watch", message, path: filePath, at: Date.now() };
    notifyInventoryStatus();

    _watchGeneration += 1;
    const retryGeneration = _watchGeneration;
    ctx.watcher = null;
    void watcher.close();
    _watchRetryTimer = setTimeout(() => {
      if (retryGeneration !== _watchGeneration) return;
      _watchRetryTimer = null;
      watchInventoryFile(filePath, source);
    }, INVENTORY_WATCH_RETRY_MS);
    _watchRetryTimer.unref?.();
  });

  watcher.on("ready", () => {
    if (generation !== _watchGeneration || _lastReadError?.kind !== "watch") return;
    _lastReadError = null;
    notifyInventoryStatus();
  });
}

function stopInventoryWatcher(): void {
  _watchGeneration += 1;
  if (_watchRetryTimer) clearTimeout(_watchRetryTimer);
  _watchRetryTimer = null;
  const watcher = ctx.watcher;
  ctx.watcher = null;
  if (watcher) void watcher.close();
}

function getLoadedInventoryModifiedAt(): number | null {
  return _loadedInventoryModifiedAt;
}

function loadInitialInventory(): { path: string; data: unknown } | null {
  if (_trustedInventorySource === "aleca" && _trustedInventoryPath) {
    const alecaPath = newestExistingInventoryPath([_trustedInventoryPath]);
    if (alecaPath) {
      watchInventoryFile(alecaPath, "aleca");
      const data = readAlecaFrameInventory(alecaPath);
      if (data) {
        return { path: alecaPath, data };
      }
      return null;
    }
  }

  // A manually imported file wins over helper output: the user picked it, and
  // nothing refreshes it but them.
  if (_trustedInventorySource === "manual" && _trustedInventoryPath) {
    const manualPath = newestExistingInventoryPath([_trustedInventoryPath]);
    if (manualPath) {
      ctx.currentInventoryPath = manualPath;
      watchInventoryFile(manualPath, "manual");
      const data = readInventory(manualPath, "manual");
      return data ? { path: manualPath, data } : null;
    }
    // Demoted, not just bypassed: leaving the pick on "manual" would keep auto
    // sync switched off for a file that no longer exists, so nothing refreshes.
    log.warn("Manually selected inventory file is gone, falling back to the helper.");
    _trustedInventorySource = "helper";
    _trustedInventoryPath = null;
    _persistState();
  }

  const filePath = findInventoryFile();
  if (!filePath) return null;
  ctx.currentInventoryPath = filePath;
  _activeInventorySource = "helper";
  watchInventoryFile(filePath);
  const data = readInventory(filePath);
  return data ? { path: filePath, data } : null;
}

function readCurrentInventory(): unknown {
  if (!ctx.currentInventoryPath) return loadInitialInventory()?.data ?? null;
  if (_activeInventorySource === "aleca") {
    return readAlecaFrameInventory(ctx.currentInventoryPath);
  }
  return readInventory(ctx.currentInventoryPath, _activeInventorySource);
}

function getInventorySource(): InventorySource {
  return _trustedInventorySource;
}

/** Re-runs discovery so a switch back to the helper picks up its output and
 *  re-arms the watcher without a restart. */
function reattachHelperInventory(): void {
  const filePath = findInventoryFile();
  if (!filePath) {
    stopInventoryWatcher();
    ctx.currentInventoryPath = null;
    _activeInventorySource = "helper";
    return;
  }
  watchInventoryFile(filePath, "helper");
  const data = readInventory(filePath, "helper");
  const window = ctx.mainWindow;
  if (data && window && !window.isDestroyed()) {
    window.webContents.send(INVENTORY_UPDATED, data);
  }
  if (data) sendToPopouts(INVENTORY_UPDATED, data);
}

/** Records the user's explicit pick and re-applies the auto-sync gate.
 *  Returns the source actually in effect, which is the caller's answer on
 *  whether the switch took. */
function setInventorySource(source: InventorySource): InventorySource {
  if (_trustedInventorySource === source) return _trustedInventorySource;

  // Only the helper can be switched to on its own; the others ARE a file, and
  // the file pickers commit them. Persisting one here would leave the helper's
  // last snapshot remembered as a hand-picked import that nothing refreshes.
  if (source !== "helper" && _activeInventorySource !== source) {
    log.warn(`Ignoring switch to "${source}" - no file has been chosen for it yet`);
    return _trustedInventorySource;
  }

  _trustedInventorySource = source;
  // The remembered file belongs to the source that picked it; keeping it would
  // shadow helper output for good.
  if (source === "helper") _trustedInventoryPath = null;
  _persistState();
  log.info(`Inventory source set to "${source}"`);
  if (source === "helper") reattachHelperInventory();
  inventorySync.apply(`source ${source}`);
  notifyInventoryStatus();
  return _trustedInventorySource;
}

function register(): void {
  handleAuthorized(INVENTORY_GET, assertMainRendererSender, async () => {
    return readCurrentInventory();
  });

  handleAuthorized(
    INVENTORY_SET_SOURCE,
    assertMainRendererSender,
    async (_event, raw: unknown) => ({
      source: setInventorySource(normalizeInventorySource(raw)),
    }),
  );

  handleAuthorized(INVENTORY_OPEN_FILE, assertMainRendererSender, async (_event, raw: unknown) => {
    // The setup wizard says whether this pick replaces the helper ("manual") or
    // just seeds it while the helper keeps refreshing.
    const source: JsonInventorySource = raw === "manual" ? "manual" : "helper";
    const openOptions: import("electron").OpenDialogOptions = {
      title: "Select warframe-api-helper inventory JSON",
      defaultPath: path.join(process.cwd(), "api-inventory-data", "inventory.json"),
      filters: [{ name: "JSON Files", extensions: ["json"] }],
      properties: ["openFile"],
    };
    const result = ctx.mainWindow
      ? await dialog.showOpenDialog(ctx.mainWindow, openOptions)
      : await dialog.showOpenDialog(openOptions);

    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const previousSource = _trustedInventorySource;
    const data = readInventory(filePath, source);

    if (data) {
      ctx.currentInventoryPath = filePath;
      watchInventoryFile(filePath, source);
      if (previousSource !== _trustedInventorySource) inventorySync.apply(`source ${source}`);
      return data;
    }
    return null;
  });

  handleAuthorized(INVENTORY_OPEN_ALECA_FRAME_FILE, assertMainRendererSender, async () => {
    const alecaDefaultPath = path.join(
      process.env.LOCALAPPDATA || app.getPath("home"),
      "AlecaFrame",
      "lastData.dat",
    );
    const openOptions: import("electron").OpenDialogOptions = {
      title: "Select AlecaFrame lastData.dat",
      defaultPath: alecaDefaultPath,
      filters: [
        { name: "AlecaFrame inventory", extensions: ["dat"] },
        { name: "All Files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    };
    const result = ctx.mainWindow
      ? await dialog.showOpenDialog(ctx.mainWindow, openOptions)
      : await dialog.showOpenDialog(openOptions);

    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const previousSource = _trustedInventorySource;
    const data = readAlecaFrameInventory(filePath);
    if (data) {
      watchInventoryFile(filePath, "aleca");
      if (previousSource !== _trustedInventorySource) inventorySync.apply("source aleca");
    }
    return data;
  });

  handleAuthorized(INVENTORY_GET_STATUS, assertMainRendererSender, async () =>
    getInventoryStatus(),
  );
}

export {
  register,
  findInventoryFile,
  loadInitialInventory,
  watchInventoryFile,
  stopInventoryWatcher,
  readInventory,
  getInventorySource,
  getInventoryStatus,
  setInventorySource,
  getLoadedInventoryModifiedAt,
};
