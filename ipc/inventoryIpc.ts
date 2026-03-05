import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { unwrapInventoryPayload } from "./inventoryPayload";
import { createRuntimeRequire } from "./runtimeRequire";

export {};

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("inventoryIpc");

const { ipcMain, dialog, app } = require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const crypto = require("node:crypto") as typeof import("node:crypto");
const chokidar = require("chokidar") as typeof import("chokidar");
const { ALECA_FETCH_TIMEOUT_MS, ALECA_KEY_SOURCE, ALECA_IV_SOURCE } = requireRuntime<{
  ALECA_FETCH_TIMEOUT_MS: number;
  ALECA_KEY_SOURCE: { url: string; sha256: string };
  ALECA_IV_SOURCE: { url: string; sha256: string };
}>("config/integrations/alecaframe");

const POSSIBLE_INVENTORY_PATHS = [
  path.join(process.cwd(), "api-inventory-data", "inventory.json"),
  path.join(app.getPath("downloads"), "inventory.json"),
  path.join(app.getPath("desktop"), "inventory.json"),
  path.join(app.getPath("documents"), "inventory.json"),
  path.join(app.getPath("home"), "inventory.json"),
  path.join(process.cwd(), "inventory.json"),
  path.join(app.getPath("userData"), "inventory.json"),
];

const ALECAFRAME_DATA_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "AlecaFrame", "lastData.dat")
  : null;

const INVENTORY_WATCH_STABILITY_MS = 500;
const ALECA_CIPHER_NAME = "aes-128-cbc";
const JSON_ENCODING = "utf-8";

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseKeyBuffer(rawText: string, label: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const wrapped = new Error(
      `Invalid ${label} JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a byte array`);
  }

  return Buffer.from(parsed);
}

async function fetchPinnedSecret(
  label: string,
  source: { url: string; sha256: string },
): Promise<string> {
  const response = await fetchTextWithTimeout(source.url, ALECA_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`${label} fetch failed with HTTP ${response.status}`);
  }

  const text = (await response.text()).trim();
  const actualHash = sha256Hex(text);
  if (actualHash !== source.sha256) {
    throw new Error(`${label} integrity mismatch`);
  }

  return text;
}

async function fetchAlecaKeys(): Promise<void> {
  try {
    if (process.env.ALECA_KEY_JSON && process.env.ALECA_IV_JSON) {
      ctx.ALECA_KEY = parseKeyBuffer(process.env.ALECA_KEY_JSON.trim(), "ALECA_KEY_JSON");
      ctx.ALECA_IV = parseKeyBuffer(process.env.ALECA_IV_JSON.trim(), "ALECA_IV_JSON");
      log.log("AlecaFrame decryption keys loaded from environment override");
      return;
    }

    const keyText = await fetchPinnedSecret("Aleca key", ALECA_KEY_SOURCE);
    const ivText = await fetchPinnedSecret("Aleca IV", ALECA_IV_SOURCE);

    ctx.ALECA_KEY = parseKeyBuffer(keyText, "Aleca key");
    ctx.ALECA_IV = parseKeyBuffer(ivText, "Aleca IV");

    log.log("AlecaFrame decryption keys loaded successfully (integrity-checked)");
  } catch (err) {
    log.error("Could not fetch AlecaFrame keys:", err instanceof Error ? err.message : String(err));
  }
}

function decryptAlecaFrame(filePath: string): unknown {
  if (!ctx.ALECA_KEY || !ctx.ALECA_IV) {
    log.error("AlecaFrame keys not loaded yet");
    return null;
  }

  try {
    const encrypted = fs.readFileSync(filePath);
    const decipher = crypto.createDecipheriv(ALECA_CIPHER_NAME, ctx.ALECA_KEY, ctx.ALECA_IV);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString(JSON_ENCODING));
  } catch (err) {
    log.error(
      "Failed to decrypt AlecaFrame data:",
      err instanceof Error ? err.message : String(err),
    );
    log.error("Try the web parser instead:");
    log.error("https://sainan.github.io/alecaframe-inventory-parser/");
    return null;
  }
}

function findInventoryFile(): string | null {
  for (const filePath of POSSIBLE_INVENTORY_PATHS) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readInventory(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, JSON_ENCODING);
    const data = unwrapInventoryPayload(JSON.parse(raw), {
      onParseError: (err: unknown) =>
        log.warn(
          "Failed to parse nested inventory payload string:",
          err instanceof Error ? err.message : String(err),
        ),
    });
    ctx.currentInventoryData = data as Record<string, unknown> | null;
    return data;
  } catch (err) {
    log.error("Failed to read inventory:", err instanceof Error ? err.message : String(err));
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

  ipcMain.handle("check-alecaframe", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "check-alecaframe");

    if (!ALECAFRAME_DATA_PATH) return { found: false, path: null, hasCachedData: false };

    const exists = fs.existsSync(ALECAFRAME_DATA_PATH);
    const cachedDataDir = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "AlecaFrame", "cachedData", "json")
      : null;
    const hasCachedData = cachedDataDir ? fs.existsSync(cachedDataDir) : false;

    return {
      found: exists,
      path: ALECAFRAME_DATA_PATH,
      lastModified: exists ? fs.statSync(ALECAFRAME_DATA_PATH).mtime.toISOString() : null,
      hasCachedData,
    };
  });

  ipcMain.handle("load-alecaframe", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "load-alecaframe");

    if (!ALECAFRAME_DATA_PATH || !fs.existsSync(ALECAFRAME_DATA_PATH)) {
      return { success: false, error: "AlecaFrame data file not found." };
    }

    if (!ctx.ALECA_KEY || !ctx.ALECA_IV) {
      await fetchAlecaKeys();
    }

    const data = decryptAlecaFrame(ALECAFRAME_DATA_PATH);
    if (data) {
      ctx.currentInventoryPath = ALECAFRAME_DATA_PATH;
      ctx.currentInventoryData = unwrapInventoryPayload(data, {
        onParseError: (err: unknown) =>
          log.warn(
            "Failed to parse nested inventory payload string:",
            err instanceof Error ? err.message : String(err),
          ),
      }) as Record<string, unknown> | null;
      watchInventoryFile(ALECAFRAME_DATA_PATH);
      return { success: true, data: ctx.currentInventoryData };
    }

    return {
      success: false,
      error:
        "Could not decrypt. The encryption key may have changed.\nUse the web parser as a fallback.",
      fallbackUrl: "https://sainan.github.io/alecaframe-inventory-parser/",
    };
  });

  ipcMain.handle("open-alecaframe-json", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "open-alecaframe-json");

    const openOptions: import("electron").OpenDialogOptions = {
      title: "Select decrypted AlecaFrame JSON",
      defaultPath: ALECAFRAME_DATA_PATH ? path.dirname(ALECAFRAME_DATA_PATH) : undefined,
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
}

export { register, fetchAlecaKeys, findInventoryFile, watchInventoryFile };

module.exports = { register, fetchAlecaKeys, findInventoryFile, watchInventoryFile };
