import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVENTORY_EXPORT } from "../../config/shared/ipcChannels";
import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

let tmpDir = "";
let savePath: string | undefined;

const chokidarMock = vi.hoisted(() => {
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const watcher = {
    close: vi.fn(),
    on: vi.fn(),
  };
  watcher.on.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
    callbacks.set(event, callback);
    return watcher;
  });
  return {
    callbacks,
    watch: vi.fn(() => watcher),
    watcher,
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => path.join(tmpDir, name),
    isPackaged: true,
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: !savePath, filePath: savePath })),
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("chokidar", () => ({
  default: { watch: chokidarMock.watch },
}));

const syncMock = vi.hoisted(() => ({ apply: vi.fn(), onGameLogin: vi.fn() }));

vi.mock("../../services/inventorySync", () => syncMock);

const HOUR = 60 * 60 * 1000;
const STATE_FILE = "inventory-reload-state.json";

function writeInventoryFile(filePath: string, mtimeMs: number): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}");
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

function writeValidInventory(filePath: string, marker: string, mtimeMs: number): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ Suits: [], marker }));
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

function writeState(inventoryPath: string, inventorySource = "json"): void {
  fs.writeFileSync(
    path.join(tmpDir, "userData", STATE_FILE),
    JSON.stringify({ hash: "x", inventoryPath, inventorySource }),
  );
}

function readState(): { inventoryPath?: string | null; inventorySource?: string } {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "userData", STATE_FILE), "utf-8"));
}

function writeAlecaInventory(filePath: string, inventory: unknown): void {
  const inventoryJson = typeof inventory === "string" ? inventory : JSON.stringify(inventory);
  const key = Buffer.from([76, 69, 79, 45, 65, 76, 69, 67, 9, 69, 79, 45, 65, 76, 69, 67]);
  const iv = Buffer.from([49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    Buffer.concat([
      cipher.update(JSON.stringify({ InventoryJson: inventoryJson }), "utf8"),
      cipher.final(),
    ]),
  );
}

const realPlatform = process.platform;

function withPlatform<T>(platform: string, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

async function loadModule(): Promise<typeof import("../../ipc/inventoryIpc")> {
  vi.resetModules();
  return import("../../ipc/inventoryIpc");
}

describe("findInventoryFile", () => {
  beforeEach(() => {
    chokidarMock.callbacks.clear();
    chokidarMock.watch.mockClear();
    chokidarMock.watcher.close.mockClear();
    chokidarMock.watcher.on.mockClear();
    syncMock.apply.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-inv-"));
    for (const dir of ["userData", "downloads", "desktop", "documents", "home"]) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
    }
  });

  afterEach(() => {
    savePath = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps no-inventory mode across startup despite an available helper file", async () => {
    const file = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "kept",
      Date.now(),
    );
    writeState(file, "none");
    const inventory = await loadModule();
    expect(inventory.getInventorySource()).toBe("none");
    expect(inventory.loadInitialInventory()).toBeNull();
    expect(chokidarMock.watch).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("disconnects the watcher without deleting inventory and can reconnect", async () => {
    const file = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "kept",
      Date.now(),
    );
    const inventory = await loadModule();
    expect(inventory.loadInitialInventory()?.data).toMatchObject({ marker: "kept" });
    expect(inventory.setInventorySource("none")).toBe("none");
    expect(chokidarMock.watcher.close).toHaveBeenCalled();
    expect(inventory.loadInitialInventory()).toBeNull();
    expect(readState().inventorySource).toBe("none");
    expect(fs.existsSync(file)).toBe(true);
    expect(syncMock.apply).toHaveBeenCalledWith("source none");
    expect(inventory.setInventorySource("helper")).toBe("helper");
    expect(inventory.loadInitialInventory()?.data).toMatchObject({ marker: "kept" });
  });

  it("prefers a fresher manual import over a stale helper snapshot", async () => {
    const now = Date.now();
    writeInventoryFile(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      now - 24 * HOUR,
    );
    const manual = writeInventoryFile(path.join(tmpDir, "downloads", "inventory_manual.json"), now);
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(manual);
  });

  it("prefers a fresher helper snapshot over an older import", async () => {
    const now = Date.now();
    const helper = writeInventoryFile(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      now,
    );
    const manual = writeInventoryFile(
      path.join(tmpDir, "downloads", "inventory_manual.json"),
      now - 24 * HOUR,
    );
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(helper);
  });

  it("ignores a user-folder inventory.json on linux", async () => {
    const downloads = writeInventoryFile(
      path.join(tmpDir, "downloads", "inventory.json"),
      Date.now(),
    );

    const { findInventoryFile } = await loadModule();
    expect(withPlatform("linux", () => findInventoryFile())).not.toBe(downloads);
    expect(withPlatform("win32", () => findInventoryFile())).toBe(downloads);
  });

  it("uses the imported path when the helper dir is empty", async () => {
    const manual = writeInventoryFile(
      path.join(tmpDir, "documents", "inventory_backup.json"),
      Date.now(),
    );
    writeState(manual);

    const { findInventoryFile } = await loadModule();
    expect(findInventoryFile()).toBe(manual);
  });

  it("falls back to user folders on windows when the remembered file is gone", async () => {
    writeState(path.join(tmpDir, "documents", "deleted.json"));
    const downloads = writeInventoryFile(
      path.join(tmpDir, "downloads", "inventory.json"),
      Date.now(),
    );

    const { findInventoryFile } = await loadModule();
    expect(withPlatform("win32", () => findInventoryFile())).toBe(downloads);
  });

  it("restores a selected AlecaFrame inventory with its decoder", async () => {
    const alecaPath = path.join(tmpDir, "local", "AlecaFrame", "lastData.dat");
    writeAlecaInventory(alecaPath, { Suits: [], marker: "aleca" });
    writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      Date.now(),
    );
    writeState(alecaPath, "aleca");

    const inventoryIpc = await loadModule();
    expect(inventoryIpc.loadInitialInventory()).toMatchObject({
      path: alecaPath,
      data: { marker: "aleca" },
    });
  });

  it("recovers when the selected AlecaFrame file becomes valid after startup", async () => {
    const alecaPath = path.join(tmpDir, "local", "AlecaFrame", "lastData.dat");
    fs.mkdirSync(path.dirname(alecaPath), { recursive: true });
    fs.writeFileSync(alecaPath, "garbage");
    writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      Date.now(),
    );
    writeState(alecaPath, "aleca");

    const inventoryIpc = await loadModule();
    const context = (await import("../../ipc/context")).default;
    const send = vi.fn();
    context.mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    } as never;

    expect(inventoryIpc.loadInitialInventory()).toBeNull();
    expect(chokidarMock.watch).toHaveBeenCalledWith(alecaPath, expect.anything());

    writeAlecaInventory(alecaPath, { Suits: [], marker: "aleca" });
    chokidarMock.callbacks.get("change")?.();

    expect(send).toHaveBeenCalledWith(
      "inventory-updated",
      expect.objectContaining({ marker: "aleca" }),
    );
  });

  it("watches the AlecaFrame file and pushes decoded updates", async () => {
    const alecaPath = path.join(tmpDir, "local", "AlecaFrame", "lastData.dat");
    writeAlecaInventory(alecaPath, { Suits: [], marker: "aleca" });
    writeState(alecaPath, "aleca");

    const inventoryIpc = await loadModule();
    const context = (await import("../../ipc/context")).default;
    const send = vi.fn();
    context.mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    } as never;

    expect(inventoryIpc.loadInitialInventory()).toMatchObject({ path: alecaPath });
    expect(chokidarMock.watch).toHaveBeenCalledWith(alecaPath, expect.anything());

    writeAlecaInventory(alecaPath, { Suits: [], marker: "fresh" });
    chokidarMock.callbacks.get("change")?.();

    expect(send).toHaveBeenCalledWith(
      "inventory-updated",
      expect.objectContaining({ marker: "fresh" }),
    );
  });

  it("exposes only the hash of loaded helper data, including inside listeners", async () => {
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "bound",
      Date.now(),
    );
    const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(helper)).digest("hex");
    writeState(helper, "helper");
    const inventoryIpc = await loadModule();
    expect(inventoryIpc.getLoadedInventoryHash()).toBeNull();
    const seen: Array<string | null> = [];
    inventoryIpc.addInventoryListener(() => seen.push(inventoryIpc.getLoadedInventoryHash()));
    inventoryIpc.readInventory(helper);
    expect(seen).toEqual([expectedHash]);
    expect(inventoryIpc.getLoadedInventoryHash()).toBe(expectedHash);
    inventoryIpc.readInventory(helper, "manual");
    expect(inventoryIpc.getLoadedInventoryHash()).toBeNull();
  });

  it("accepts changed helper contents immediately after the startup read", async () => {
    const now = Date.now();
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "startup",
      now - 60_000,
    );
    const inventoryIpc = await loadModule();
    const listener = vi.fn();
    inventoryIpc.addInventoryListener(listener);

    expect(inventoryIpc.readInventory(helper)).toMatchObject({ marker: "startup" });
    inventoryIpc.watchInventoryFile(helper);

    writeValidInventory(helper, "fresh", now);
    chokidarMock.callbacks.get("change")?.();

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ marker: "fresh" }));
    expect(inventoryIpc.getLoadedInventoryModifiedAt()).toBeCloseTo(now, -2);
  });

  it("keeps the loaded timestamp when a replacement payload is invalid", async () => {
    const now = Date.now();
    const startupMtime = now - 60_000;
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "startup",
      startupMtime,
    );
    const inventoryIpc = await loadModule();

    inventoryIpc.readInventory(helper);
    inventoryIpc.watchInventoryFile(helper);
    fs.writeFileSync(helper, "{invalid");
    fs.utimesSync(helper, now / 1000, now / 1000);
    chokidarMock.callbacks.get("change")?.();

    expect(inventoryIpc.getLoadedInventoryModifiedAt()).toBeCloseTo(startupMtime, -2);
  });

  it("deduplicates identical rewrites while advancing their accepted timestamp", async () => {
    const now = Date.now();
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "same",
      now - 60_000,
    );
    const inventoryIpc = await loadModule();
    const listener = vi.fn();
    inventoryIpc.addInventoryListener(listener);

    inventoryIpc.readInventory(helper);
    inventoryIpc.watchInventoryFile(helper);
    writeValidInventory(helper, "same", now);
    chokidarMock.callbacks.get("change")?.();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(inventoryIpc.getLoadedInventoryModifiedAt()).toBeCloseTo(now, -2);
  });

  it("reports watcher errors and re-arms the watcher", async () => {
    vi.useFakeTimers();
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "watched",
      Date.now(),
    );
    const inventoryIpc = await loadModule();
    const context = (await import("../../ipc/context")).default;
    const send = vi.fn();
    context.mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    } as never;

    inventoryIpc.watchInventoryFile(helper);
    chokidarMock.callbacks.get("error")?.(new Error("permission denied"));

    expect(send).toHaveBeenCalledWith(
      "inventory-status-updated",
      expect.objectContaining({
        path: helper,
        found: true,
        lastError: expect.objectContaining({ kind: "watch", message: "permission denied" }),
      }),
    );
    expect(chokidarMock.watcher.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(chokidarMock.watch).toHaveBeenCalledTimes(2);
    chokidarMock.callbacks.get("ready")?.();
    expect(send).toHaveBeenLastCalledWith(
      "inventory-status-updated",
      expect.objectContaining({ lastError: null }),
    );
    vi.useRealTimers();
  });

  it("restores every persisted inventory source across restarts", async () => {
    const inventoryPath = path.join(tmpDir, "downloads", "inventory.json");
    for (const source of ["helper", "manual", "aleca"] as const) {
      writeState(inventoryPath, source);
      const { getInventorySource } = await loadModule();
      expect(getInventorySource()).toBe(source);
    }
  });

  it("treats the legacy json source and a missing state as helper", async () => {
    writeState(path.join(tmpDir, "downloads", "inventory.json"), "json");
    expect((await loadModule()).getInventorySource()).toBe("helper");

    fs.rmSync(path.join(tmpDir, "userData", STATE_FILE));
    expect((await loadModule()).getInventorySource()).toBe("helper");
  });

  it("persists a source change for the next start", async () => {
    writeState(path.join(tmpDir, "downloads", "inventory_manual.json"), "manual");
    const inventoryIpc = await loadModule();
    expect(inventoryIpc.setInventorySource("helper")).toBe("helper");

    expect(readState().inventorySource).toBe("helper");
    expect((await loadModule()).getInventorySource()).toBe("helper");
  });

  // Those sources ARE a file, and only the pickers can produce one. Persisting
  // the switch on its own freezes the helper's last output as a hand-picked import
  // that nothing refreshes, since auto sync is off for everything but the helper.
  it("refuses a switch to a file source before a file has been picked", async () => {
    const inventoryIpc = await loadModule();

    expect(inventoryIpc.setInventorySource("manual")).toBe("helper");
    expect(inventoryIpc.setInventorySource("aleca")).toBe("helper");
    expect(inventoryIpc.getInventorySource()).toBe("helper");
    expect((await loadModule()).getInventorySource()).toBe("helper");
  });

  it("reports the persisted source through the status getter", async () => {
    const inventoryPath = path.join(tmpDir, "downloads", "inventory.json");
    for (const source of ["helper", "manual", "aleca"] as const) {
      writeState(inventoryPath, source);
      const { getInventoryStatus } = await loadModule();
      expect(getInventoryStatus()).toMatchObject({ source, found: false });
    }
  });

  it("drops the manual path and reattaches helper output when switching back", async () => {
    const now = Date.now();
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      now,
    );
    const manual = writeValidInventory(
      path.join(tmpDir, "downloads", "inventory_manual.json"),
      "manual",
      now - 24 * HOUR,
    );
    writeState(manual, "manual");

    const inventoryIpc = await loadModule();
    inventoryIpc.loadInitialInventory();
    expect(inventoryIpc.getInventoryStatus()).toMatchObject({ source: "manual", path: manual });

    expect(inventoryIpc.setInventorySource("helper")).toBe("helper");

    expect(inventoryIpc.getInventoryStatus()).toMatchObject({ source: "helper", path: helper });
    expect(chokidarMock.watch).toHaveBeenLastCalledWith(helper, expect.anything());
    expect(readState()).toMatchObject({ inventorySource: "helper", inventoryPath: helper });
    expect(syncMock.apply).toHaveBeenCalledWith("source helper");
  });

  // Staying on "manual" for a file that is gone keeps auto sync switched off,
  // so the helper output it silently falls back to would never refresh again.
  it("demotes a manual pick to the helper once its file disappears", async () => {
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      Date.now(),
    );
    writeState(path.join(tmpDir, "downloads", "deleted_by_the_user.json"), "manual");

    const inventoryIpc = await loadModule();
    inventoryIpc.loadInitialInventory();

    expect(inventoryIpc.getInventoryStatus()).toMatchObject({ source: "helper", path: helper });
    expect(readState()).toMatchObject({ inventorySource: "helper", inventoryPath: helper });
    expect((await loadModule()).getInventorySource()).toBe("helper");
  });

  it("forgets the manual path even when no helper output exists yet", async () => {
    const manual = writeValidInventory(
      path.join(tmpDir, "downloads", "backup", "inventory.json"),
      "manual",
      Date.now(),
    );
    writeState(manual, "manual");

    const inventoryIpc = await loadModule();
    inventoryIpc.loadInitialInventory();
    inventoryIpc.setInventorySource("helper");

    expect(inventoryIpc.getInventoryStatus()).toMatchObject({ source: "helper", found: false });
    expect(readState().inventoryPath).toBeNull();
    expect(syncMock.apply).toHaveBeenCalledWith("source helper");
  });

  it("keeps loading the manual selection when helper output is newer", async () => {
    const now = Date.now();
    writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      now,
    );
    const manual = writeValidInventory(
      path.join(tmpDir, "downloads", "inventory_manual.json"),
      "manual",
      now - 24 * HOUR,
    );
    writeState(manual, "manual");

    const inventoryIpc = await loadModule();
    expect(inventoryIpc.loadInitialInventory()).toMatchObject({
      path: manual,
      data: { marker: "manual" },
    });
    expect(chokidarMock.watch).toHaveBeenCalledWith(manual, expect.anything());
    expect(inventoryIpc.getInventorySource()).toBe("manual");
  });

  it("watches the manual file and keeps the source on external updates", async () => {
    const now = Date.now();
    const manual = writeValidInventory(
      path.join(tmpDir, "downloads", "inventory_manual.json"),
      "manual",
      now - 60_000,
    );
    writeState(manual, "manual");

    const inventoryIpc = await loadModule();
    const context = (await import("../../ipc/context")).default;
    const send = vi.fn();
    context.mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    } as never;

    inventoryIpc.loadInitialInventory();
    writeValidInventory(manual, "fresh", now);
    chokidarMock.callbacks.get("change")?.();

    expect(send).toHaveBeenCalledWith(
      "inventory-updated",
      expect.objectContaining({ marker: "fresh" }),
    );
    expect(inventoryIpc.getInventorySource()).toBe("manual");
  });

  it("falls back to discovery when the manual file is gone", async () => {
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "helper",
      Date.now(),
    );
    writeState(path.join(tmpDir, "downloads", "deleted.json"), "manual");

    const inventoryIpc = await loadModule();
    expect(inventoryIpc.loadInitialInventory()).toMatchObject({ path: helper });
    expect(inventoryIpc.getInventorySource()).toBe("helper");
  });

  it("cancels a pending watcher retry during shutdown", async () => {
    vi.useFakeTimers();
    const helper = writeValidInventory(
      path.join(tmpDir, "userData", "api-helper", "inventory.json"),
      "watched",
      Date.now(),
    );
    const inventoryIpc = await loadModule();

    inventoryIpc.watchInventoryFile(helper);
    chokidarMock.callbacks.get("error")?.(new Error("permission denied"));
    inventoryIpc.stopInventoryWatcher();
    inventoryIpc.stopInventoryWatcher();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  async function registerExport(): Promise<{
    inventoryIpc: typeof import("../../ipc/inventoryIpc");
    exportInventory: () => Promise<unknown>;
  }> {
    const inventoryIpc = await loadModule();
    const { ipcMain } = await import("electron");
    const context = (await import("../../ipc/context")).default;
    inventoryIpc.register();
    const exportCalls = vi
      .mocked(ipcMain.handle)
      .mock.calls.filter(([channel]) => channel === INVENTORY_EXPORT);
    const handler = exportCalls[exportCalls.length - 1]?.[1];
    if (!handler) throw new Error("no export handler");
    context.mainWindow = makeWindowStub(7);
    const event = makeEvent(7, "file:///D:/app/renderer/dist/index.html");
    return { inventoryIpc, exportInventory: async () => handler(event as never) };
  }

  // A parse and stringify round trip would print the seed as 12345678901234567000.
  const EXPORT_SOURCE =
    '{"Suits":[],"Seed":12345678901234567891,"Nested":{"Empty":{},"List":[1,"a\\"b"]}}';
  const EXPORT_EXPECTED = JSON.stringify(
    { Suits: [], Seed: 0, Nested: { Empty: {}, List: [1, 'a"b'] } },
    null,
    2,
  ).replace('"Seed": 0', '"Seed": 12345678901234567891');

  it("exports the helper inventory indented with every digit kept", async () => {
    const file = path.join(tmpDir, "userData", "api-helper", "inventory.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, EXPORT_SOURCE);
    savePath = path.join(tmpDir, "documents", "readable.json");
    const { inventoryIpc, exportInventory } = await registerExport();
    inventoryIpc.loadInitialInventory();

    expect(await exportInventory()).toEqual({ saved: true, path: savePath });
    expect(fs.readFileSync(savePath, "utf-8")).toBe(EXPORT_EXPECTED);
  });

  it("exports the inventory inside an AlecaFrame file, not its envelope", async () => {
    const alecaPath = path.join(tmpDir, "local", "AlecaFrame", "lastData.dat");
    writeAlecaInventory(alecaPath, EXPORT_SOURCE);
    writeState(alecaPath, "aleca");
    savePath = path.join(tmpDir, "documents", "readable.json");
    const { inventoryIpc, exportInventory } = await registerExport();
    inventoryIpc.loadInitialInventory();

    expect(await exportInventory()).toEqual({ saved: true, path: savePath });
    expect(fs.readFileSync(savePath, "utf-8")).toBe(EXPORT_EXPECTED);
  });

  it("reports a missing inventory instead of opening the save dialog", async () => {
    savePath = path.join(tmpDir, "documents", "never.json");
    const { exportInventory } = await registerExport();
    const { dialog } = await import("electron");
    vi.mocked(dialog.showSaveDialog).mockClear();

    expect(await exportInventory()).toEqual({ saved: false, error: "noInventory" });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(fs.existsSync(savePath)).toBe(false);
  });
});
