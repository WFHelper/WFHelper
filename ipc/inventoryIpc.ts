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
  INVENTORY_UPDATED,
} from "../config/shared/ipcChannels";
import { readAlecaFrameInventoryFile } from "../services/alecaFrameInventory";
import { dialog, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import chokidar from "chokidar";
import crypto from "node:crypto";

const log = withScope("inventoryIpc");

const HELPER_INVENTORY_DIRECTORIES = [path.join(app.getPath("userData"), "api-helper")];

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
const MIN_RELOAD_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_INVENTORY_BYTES = 50 * 1024 * 1024;
const JSON_ENCODING = "utf-8";

let _lastInventoryHash: string | null = null;
let _lastReloadAt = 0;
let _lastListenerInventoryHash: string | null = null;
let _trustedInventoryPath: string | null = null;

interface InventoryReadError {
  kind: "parse" | "read";
  message: string;
  path: string;
  at: number;
}
let _lastReadError: InventoryReadError | null = null;

const _inventoryStatePath = path.join(app.getPath("userData"), "inventory-reload-state.json");

function _loadPersistedState(): void {
  try {
    const raw = fs.readFileSync(_inventoryStatePath, JSON_ENCODING);
    const data = JSON.parse(raw) as { hash?: string; reloadAt?: number; inventoryPath?: string };
    if (typeof data.hash === "string") _lastInventoryHash = data.hash;
    if (typeof data.reloadAt === "number") _lastReloadAt = data.reloadAt;
    if (typeof data.inventoryPath === "string") _trustedInventoryPath = data.inventoryPath;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    if (code !== "ENOENT") {
      log.debug(
        "[Inventory] persisted reload state missing or corrupt; starting fresh:",
        normalizeErrorMessage(err),
      );
    }
    // missing or corrupt — start fresh
  }
}

function _persistState(): void {
  try {
    fs.writeFileSync(
      _inventoryStatePath,
      JSON.stringify({
        hash: _lastInventoryHash,
        reloadAt: _lastReloadAt,
        inventoryPath: _trustedInventoryPath,
      }),
      JSON_ENCODING,
    );
  } catch (err) {
    log.debug("[Inventory] failed to persist reload state:", normalizeErrorMessage(err));
    // best-effort
  }
}

_loadPersistedState();

type InventoryDataListener = (data: Record<string, unknown>) => void;
const _inventoryListeners: InventoryDataListener[] = [];

/**
 * Register a main-process callback to be called whenever inventory data is read.
 * Returns an unsubscribe function.
 */
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


function rememberInventoryPath(filePath: string): void {
  if (_trustedInventoryPath === filePath) return;
  _trustedInventoryPath = filePath;
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
  const helperCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(HELPER_INVENTORY_DIRECTORIES),
  );
  if (helperCandidate) return helperCandidate;

  const trustedCandidate = _trustedInventoryPath
    ? newestExistingInventoryPath([_trustedInventoryPath])
    : null;
  if (trustedCandidate) return trustedCandidate;

  const userCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(USER_INVENTORY_DIRECTORIES),
  );
  if (userCandidate) {
    log.warn("Using inventory file discovered from user-writable folders:", userCandidate);
    return userCandidate;
  }

  const allowDevFallback = process.env.NODE_ENV !== "production";
  if (!allowDevFallback) return null;

  const devCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(DEV_FALLBACK_INVENTORY_DIRECTORIES),
  );
  if (devCandidate) {
    log.warn("Using development fallback inventory file:", devCandidate);
  }
  return devCandidate;
}

function readInventoryRaw(filePath: string): string | null {
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
    return fs.readFileSync(filePath, JSON_ENCODING);
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

function readInventory(filePath: string): unknown {
  const raw = readInventoryRaw(filePath);
  if (raw == null) return null;

  let data: unknown;
  try {
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const now = Date.now();
    const withinCooldown = now - _lastReloadAt < MIN_RELOAD_INTERVAL_MS;
    const contentUnchanged = hash === _lastInventoryHash;

    // Always parse so ctx.currentInventoryData is populated for the UI
    data = parseInventoryRaw(raw);
    ctx.currentInventoryData = data as Record<string, unknown> | null;
    _lastReadError = null;
    rememberInventoryPath(filePath);

    _notifyListenersOncePerProcessHash(hash, data);

    if (withinCooldown && contentUnchanged) {
      log.info("Inventory read skipped broadcast (unchanged within 10 min cooldown).");
      return data;
    }

    _lastInventoryHash = hash;
    _lastReloadAt = now;
    _persistState();
    return data;
  } catch (err) {
    const message = normalizeErrorMessage(err);
    log.error(`Failed to parse inventory at ${filePath}:`, message);
    _lastReadError = { kind: "parse", message, path: filePath, at: Date.now() };
    return null;
  }
}

function readAlecaFrameInventory(filePath: string): unknown {
  try {
    const data = readAlecaFrameInventoryFile(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    ctx.currentInventoryData = data as Record<string, unknown> | null;
    _lastReadError = null;
    _lastInventoryHash = hash;
    _lastReloadAt = Date.now();
    _persistState();
    _notifyListenersOncePerProcessHash(hash, data);
    return data;
  } catch (err) {
    const message = normalizeErrorMessage(err);
    log.error(`Failed to decrypt AlecaFrame inventory at ${filePath}:`, message);
    _lastReadError = { kind: "parse", message, path: filePath, at: Date.now() };
    return null;
  }
}

function watchInventoryFile(filePath: string): void {
  if (ctx.watcher) {
    void ctx.watcher.close();
  }

  ctx.watcher = chokidar.watch(filePath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: INVENTORY_WATCH_STABILITY_MS },
  });

  ctx.watcher.on("change", () => {
    const now = Date.now();
    if (now - _lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
      // Intentional 10m cooldown
      log.info("Inventory file changed, skipping (too soon after last reload).");
      return;
    }

    const raw = readInventoryRaw(filePath);
    if (raw == null) return;

    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    if (hash === _lastInventoryHash) {
      log.info("Inventory file touched but content unchanged, skipping reload.");
      return;
    }

    _lastReloadAt = now;
    _lastInventoryHash = hash;
    _persistState();
    log.info("Inventory file changed, reloading...");

    try {
      const data = parseInventoryRaw(raw);
      ctx.currentInventoryData = data as Record<string, unknown> | null;
      _lastReadError = null;
      rememberInventoryPath(filePath);
      _notifyListenersOncePerProcessHash(hash, data);
      if (data && ctx.mainWindow) {
        ctx.mainWindow.webContents.send(INVENTORY_UPDATED, data);
      }
    } catch (err) {
      const message = normalizeErrorMessage(err);
      log.error("Failed to parse inventory:", message);
      _lastReadError = { kind: "parse", message, path: filePath, at: Date.now() };
    }
  });
}

function register(): void {
  handleAuthorized(INVENTORY_GET, assertMainRendererSender, async () => {
    if (!ctx.currentInventoryPath) {
      const discovered = findInventoryFile();
      if (discovered) {
        ctx.currentInventoryPath = discovered;
        watchInventoryFile(discovered);
      }
    }

    if (ctx.currentInventoryPath) {
      return readInventory(ctx.currentInventoryPath);
    }

    return null;
  });

  handleAuthorized(INVENTORY_OPEN_FILE, assertMainRendererSender, async () => {
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
    const data = readInventory(filePath);

    if (data) {
      ctx.currentInventoryPath = filePath;
      watchInventoryFile(filePath);
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
    return readAlecaFrameInventory(result.filePaths[0]);
  });

  handleAuthorized(INVENTORY_GET_STATUS, assertMainRendererSender, async () => ({
    path: ctx.currentInventoryPath,
    found: ctx.currentInventoryPath !== null,
    lastError: _lastReadError,
  }));
}

export { register, findInventoryFile, watchInventoryFile, readInventory };
