import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => path.join(tmpDir, name),
    isPackaged: true,
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: { handle: vi.fn() },
}));

const HOUR = 60 * 60 * 1000;

function writeInventoryFile(filePath: string, mtimeMs: number): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}");
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

function writeState(inventoryPath: string): void {
  fs.writeFileSync(
    path.join(tmpDir, "userData", "inventory-reload-state.json"),
    JSON.stringify({ hash: "x", reloadAt: 0, inventoryPath }),
  );
}

async function loadModule(): Promise<typeof import("../../ipc/inventoryIpc")> {
  vi.resetModules();
  return import("../../ipc/inventoryIpc");
}

describe("findInventoryFile", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-inv-"));
    for (const dir of ["userData", "downloads", "desktop", "documents", "home"]) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers a fresher manual import over a stale helper snapshot", async () => {
    const now = Date.now();
    writeInventoryFile(path.join(tmpDir, "userData", "api-helper", "inventory.json"), now - 24 * HOUR);
    const manual = writeInventoryFile(path.join(tmpDir, "downloads", "inventory_manual.json"), now);
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(manual);
  });

  it("prefers a fresher helper snapshot over an older import", async () => {
    const now = Date.now();
    const helper = writeInventoryFile(path.join(tmpDir, "userData", "api-helper", "inventory.json"), now);
    const manual = writeInventoryFile(path.join(tmpDir, "downloads", "inventory_manual.json"), now - 24 * HOUR);
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(helper);
  });

  it("uses the imported path when the helper dir is empty", async () => {
    const manual = writeInventoryFile(path.join(tmpDir, "documents", "inventory_backup.json"), Date.now());
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(manual);
  });

  it("falls back to user folders when the remembered file is gone", async () => {
    writeState(path.join(tmpDir, "documents", "deleted.json"));
    const downloads = writeInventoryFile(path.join(tmpDir, "downloads", "inventory.json"), Date.now());

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(downloads);
  });
});
