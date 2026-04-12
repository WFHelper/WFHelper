import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { unwrapInventoryPayload } from "./inventoryPayload";
import { withScope } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { ipcMain, dialog, app } from "electron";
import path from "node:path";
import fs from "node:fs";
import chokidar from "chokidar";
import crypto from "node:crypto";

const log = withScope("inventoryIpc");

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
const JSON_ENCODING = "utf-8";

let _lastInventoryHash: string | null = null;
let _lastReloadAt = 0;

const _inventoryStatePath = path.join(app.getPath("userData"), "inventory-reload-state.json");

function _loadPersistedState(): void {
  try {
    const raw = fs.readFileSync(_inventoryStatePath, JSON_ENCODING);
    const data = JSON.parse(raw) as { hash?: string; reloadAt?: number };
    if (typeof data.hash === "string") _lastInventoryHash = data.hash;
    if (typeof data.reloadAt === "number") _lastReloadAt = data.reloadAt;
  } catch {
    // missing or corrupt — start fresh
  }
}

function _persistState(): void {
  try {
    fs.writeFileSync(
      _inventoryStatePath,
      JSON.stringify({ hash: _lastInventoryHash, reloadAt: _lastReloadAt }),
      JSON_ENCODING,
    );
  } catch {
    // best-effort
  }
}

_loadPersistedState();

// ── Inventory data listeners ───────────────────────────────────────────────────

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
    } catch {
      // ignore
    }
  }
}

function newestExistingInventoryPath(paths: string[]): string | null {
  let bestPath: string | null = null;
  let bestMtimeMs = -1;

  for (const filePath of paths) {
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
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
  const userCandidate = newestExistingInventoryPath(
    collectInventoryCandidates(USER_INVENTORY_DIRECTORIES),
  );
  if (userCandidate) return userCandidate;

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

function readInventory(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, JSON_ENCODING);
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const now = Date.now();
    const withinCooldown = now - _lastReloadAt < MIN_RELOAD_INTERVAL_MS;
    const contentUnchanged = hash === _lastInventoryHash;

    // Always parse so ctx.currentInventoryData is populated for the UI
    const data = unwrapInventoryPayload(JSON.parse(raw), {
      onParseError: (err: unknown) =>
        log.warn("Failed to parse nested inventory payload string:", normalizeErrorMessage(err)),
    });
    ctx.currentInventoryData = data as Record<string, unknown> | null;

    if (withinCooldown && contentUnchanged) {
      log.log("Inventory read skipped broadcast (unchanged within 10 min cooldown).");
      return data;
    }

    _lastInventoryHash = hash;
    _lastReloadAt = now;
    _persistState();
    if (data && typeof data === "object") {
      _notifyListeners(data as Record<string, unknown>);
    }
    return data;
  } catch (err) {
    log.error("Failed to read inventory:", normalizeErrorMessage(err));
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
      log.log("Inventory file changed, skipping (too soon after last reload).");
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, JSON_ENCODING);
    } catch (err) {
      log.error("Failed to read inventory file:", normalizeErrorMessage(err));
      return;
    }

    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    if (hash === _lastInventoryHash) {
      log.log("Inventory file touched but content unchanged, skipping reload.");
      return;
    }

    _lastReloadAt = now;
    _lastInventoryHash = hash;
    _persistState();
    log.log("Inventory file changed, reloading...");

    try {
      const data = unwrapInventoryPayload(JSON.parse(raw), {
        onParseError: (err: unknown) =>
          log.warn("Failed to parse nested inventory payload string:", normalizeErrorMessage(err)),
      });
      ctx.currentInventoryData = data as Record<string, unknown> | null;
      if (data && typeof data === "object") {
        _notifyListeners(data as Record<string, unknown>);
      }
      if (data && ctx.mainWindow) {
        ctx.mainWindow.webContents.send("inventory-updated", data);
      }
    } catch (err) {
      log.error("Failed to parse inventory:", normalizeErrorMessage(err));
    }
  });
}

function register(): void {
  ipcMain.handle("get-inventory", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-inventory");

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

  ipcMain.handle("open-inventory-file", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "open-inventory-file");

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

  ipcMain.handle("get-inventory-status", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-inventory-status");
    return {
      path: ctx.currentInventoryPath,
      found: ctx.currentInventoryPath !== null,
    };
  });
}

export { register, findInventoryFile, watchInventoryFile, readInventory };
