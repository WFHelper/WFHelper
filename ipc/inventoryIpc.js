/**
 * Inventory & AlecaFrame IPC handlers.
 * Handles: get-inventory, open-inventory-file, get-inventory-status,
 *          check-alecaframe, load-alecaframe, open-alecaframe-json
 */

const { ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const chokidar = require('chokidar');
const ctx = require('./context');

// ─── Config ──────────────────────────────────────────────────────────────────

const POSSIBLE_INVENTORY_PATHS = [
  path.join(app.getPath('userData'), 'inventory.json'),
  path.join(app.getPath('home'), 'inventory.json'),
  path.join(app.getPath('desktop'), 'inventory.json'),
];

const ALECAFRAME_DATA_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'AlecaFrame', 'lastData.dat')
  : null;

// ─── AlecaFrame Decryption ───────────────────────────────────────────────────

async function fetchAlecaKeys() {
  try {
    const keyResp = await fetch('https://gist.githubusercontent.com/nrbdev/cd73cc5c02ee5e23aca3251423aa85b0/raw/');
    const keyText = (await keyResp.text()).trim();
    ctx.ALECA_KEY = Buffer.from(JSON.parse(keyText));

    const ivResp = await fetch('https://gist.githubusercontent.com/nrbdev/8ebb6a1849ebbf80724b26faf30451a1/raw/');
    const ivText = (await ivResp.text()).trim();
    ctx.ALECA_IV = Buffer.from(JSON.parse(ivText));

    console.log('AlecaFrame decryption keys loaded successfully');
  } catch (err) {
    console.error('Could not fetch AlecaFrame keys:', err.message);
  }
}

function decryptAlecaFrame(filePath) {
  if (!ctx.ALECA_KEY || !ctx.ALECA_IV) {
    console.error('AlecaFrame keys not loaded yet');
    return null;
  }
  try {
    const encrypted = fs.readFileSync(filePath);
    const decipher = crypto.createDecipheriv('aes-128-cbc', ctx.ALECA_KEY, ctx.ALECA_IV);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    console.error('Failed to decrypt AlecaFrame data:', err.message);
    console.error('Try the web parser instead:');
    console.error('https://sainan.github.io/alecaframe-inventory-parser/');
    return null;
  }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function findInventoryFile() {
  for (const p of POSSIBLE_INVENTORY_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readInventory(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    ctx.currentInventoryData = data;
    return data;
  } catch (err) {
    console.error('Failed to read inventory:', err.message);
    return null;
  }
}

function watchInventoryFile(filePath) {
  if (ctx.watcher) ctx.watcher.close();

  ctx.watcher = chokidar.watch(filePath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
  });

  ctx.watcher.on('change', () => {
    console.log('Inventory file changed, reloading...');
    const data = readInventory(filePath);
    if (data && ctx.mainWindow) {
      ctx.mainWindow.webContents.send('inventory-updated', data);
    }
  });
}

// ─── IPC Registration ─────────────────────────────────────────────────────────

function register() {
  // Return current inventory (re-read from disk)
  ipcMain.handle('get-inventory', async () => {
    if (ctx.currentInventoryPath) {
      return readInventory(ctx.currentInventoryPath);
    }
    return null;
  });

  // User manually picks an inventory JSON
  ipcMain.handle('open-inventory-file', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Select your Warframe inventory JSON',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile'],
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

  // Returns whether an inventory is currently loaded
  ipcMain.handle('get-inventory-status', async () => ({
    path: ctx.currentInventoryPath,
    found: ctx.currentInventoryPath !== null,
  }));

  // Check whether AlecaFrame's data file exists
  ipcMain.handle('check-alecaframe', async () => {
    if (!ALECAFRAME_DATA_PATH) return { found: false, path: null, hasCachedData: false };

    const exists = fs.existsSync(ALECAFRAME_DATA_PATH);
    const cachedDataDir = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'AlecaFrame', 'cachedData', 'json')
      : null;
    const hasCachedData = cachedDataDir ? fs.existsSync(cachedDataDir) : false;

    return {
      found: exists,
      path: ALECAFRAME_DATA_PATH,
      lastModified: exists ? fs.statSync(ALECAFRAME_DATA_PATH).mtime.toISOString() : null,
      hasCachedData,
    };
  });

  // Attempt to auto-decrypt AlecaFrame's lastData.dat
  ipcMain.handle('load-alecaframe', async () => {
    if (!ALECAFRAME_DATA_PATH || !fs.existsSync(ALECAFRAME_DATA_PATH)) {
      return { success: false, error: 'AlecaFrame data file not found.' };
    }

    const data = decryptAlecaFrame(ALECAFRAME_DATA_PATH);
    if (data) {
      ctx.currentInventoryPath = ALECAFRAME_DATA_PATH;
      ctx.currentInventoryData = data;
      watchInventoryFile(ALECAFRAME_DATA_PATH);
      return { success: true, data };
    }

    return {
      success: false,
      error: 'Could not decrypt. The encryption key may have changed.\nUse the web parser as a fallback.',
      fallbackUrl: 'https://sainan.github.io/alecaframe-inventory-parser/',
    };
  });

  // User picks a pre-decrypted AlecaFrame JSON (from the web parser)
  ipcMain.handle('open-alecaframe-json', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Select decrypted AlecaFrame JSON',
      defaultPath: ALECAFRAME_DATA_PATH ? path.dirname(ALECAFRAME_DATA_PATH) : undefined,
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile'],
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
