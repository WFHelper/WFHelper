import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { unwrapInventoryPayload } from "./inventoryPayload";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope } from "../services/logger";


const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = withScope("inventoryIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, dialog, app } = require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const chokidar = require("chokidar") as typeof import("chokidar");

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
const JSON_ENCODING = "utf-8";

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
    const data = unwrapInventoryPayload(JSON.parse(raw), {
      onParseError: (err: unknown) =>
        log.warn("Failed to parse nested inventory payload string:", normalizeErrorMessage(err)),
    });
    ctx.currentInventoryData = data as Record<string, unknown> | null;
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
    log.log("Inventory file changed, reloading...");
    const data = readInventory(filePath);
    if (data && ctx.mainWindow) {
      ctx.mainWindow.webContents.send("inventory-updated", data);
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

export { register, findInventoryFile, watchInventoryFile };
