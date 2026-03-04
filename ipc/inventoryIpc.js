const log = require("../services/logger").withScope("inventoryIpc");
/**
 * Inventory & AlecaFrame IPC handlers.
 * Handles: get-inventory, open-inventory-file, get-inventory-status,
 *          check-alecaframe, load-alecaframe, open-alecaframe-json
 */

const { ipcMain, dialog, app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const chokidar = require("chokidar");
const ctx = require("./context");
const { assertMainRendererSender, assertAuthorizedSender } = require("./ipcSecurity");
const {
  ALECA_FETCH_TIMEOUT_MS,
  ALECA_KEY_SOURCE,
  ALECA_IV_SOURCE,
} = require("../config/integrations/alecaframe");

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

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseKeyBuffer(rawText, label) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Invalid ${label} JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a byte array`);
  }

  return Buffer.from(parsed);
}

async function fetchPinnedSecret(label, source) {
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

async function fetchAlecaKeys() {
  try {
    // Optional local override for emergency key rotation.
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
    log.error("Could not fetch AlecaFrame keys:", err.message);
  }
}

function decryptAlecaFrame(filePath) {
  if (!ctx.ALECA_KEY || !ctx.ALECA_IV) {
    log.error("AlecaFrame keys not loaded yet");
    return null;
  }

  try {
    const encrypted = fs.readFileSync(filePath);
    const decipher = crypto.createDecipheriv("aes-128-cbc", ctx.ALECA_KEY, ctx.ALECA_IV);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString("utf-8"));
  } catch (err) {
    log.error("Failed to decrypt AlecaFrame data:", err.message);
    log.error("Try the web parser instead:");
    log.error("https://sainan.github.io/alecaframe-inventory-parser/");
    return null;
  }
}

function hasInventoryShape(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    Array.isArray(value.Suits) ||
    Array.isArray(value.Upgrades) ||
    Array.isArray(value.Arcanes) ||
    Array.isArray(value.LevelKeys) ||
    Array.isArray(value.MiscItems),
  );
}

function unwrapInventoryPayload(value) {
  let current = value;

  for (let i = 0; i < 4; i += 1) {
    if (hasInventoryShape(current)) return current;
    if (!current || typeof current !== "object") return current;

    const next =
      current.InventoryJson ??
      current.inventoryJson ??
      current.inventory_json ??
      current.payload ??
      current.data;

    if (typeof next === "string") {
      try {
        current = JSON.parse(next);
        continue;
      } catch (err) {
        log.warn("Failed to parse nested inventory payload string:", err.message);
        return current;
      }
    }

    if (next && typeof next === "object") {
      current = next;
      continue;
    }

    return current;
  }

  return current;
}

function findInventoryFile() {
  for (const p of POSSIBLE_INVENTORY_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readInventory(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = unwrapInventoryPayload(JSON.parse(raw));
    ctx.currentInventoryData = data;
    return data;
  } catch (err) {
    log.error("Failed to read inventory:", err.message);
    return null;
  }
}

function watchInventoryFile(filePath) {
  if (ctx.watcher) ctx.watcher.close();

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

function register() {
  ipcMain.handle("get-inventory", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-inventory");

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

  ipcMain.handle("open-inventory-file", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "open-inventory-file");

    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: "Select warframe-api-helper inventory JSON",
      defaultPath: path.join(process.cwd(), "api-inventory-data", "inventory.json"),
      filters: [{ name: "JSON Files", extensions: ["json"] }],
      properties: ["openFile"],
    });

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

  ipcMain.handle("get-inventory-status", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-inventory-status");
    return {
      path: ctx.currentInventoryPath,
      found: ctx.currentInventoryPath !== null,
    };
  });

  ipcMain.handle("check-alecaframe", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "check-alecaframe");

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

  ipcMain.handle("load-alecaframe", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "load-alecaframe");

    if (!ALECAFRAME_DATA_PATH || !fs.existsSync(ALECAFRAME_DATA_PATH)) {
      return { success: false, error: "AlecaFrame data file not found." };
    }

    if (!ctx.ALECA_KEY || !ctx.ALECA_IV) {
      await fetchAlecaKeys();
    }

    const data = decryptAlecaFrame(ALECAFRAME_DATA_PATH);
    if (data) {
      ctx.currentInventoryPath = ALECAFRAME_DATA_PATH;
      ctx.currentInventoryData = unwrapInventoryPayload(data);
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

  ipcMain.handle("open-alecaframe-json", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "open-alecaframe-json");

    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: "Select decrypted AlecaFrame JSON",
      defaultPath: ALECAFRAME_DATA_PATH ? path.dirname(ALECAFRAME_DATA_PATH) : undefined,
      filters: [{ name: "JSON Files", extensions: ["json"] }],
      properties: ["openFile"],
    });

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

module.exports = { register, fetchAlecaKeys, findInventoryFile, watchInventoryFile };
