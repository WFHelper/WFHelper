import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
let tmpDir: string;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  shell: { showItemInFolder: vi.fn() },
  app: {
    getPath: () => tmpDir,
  },
}));

const MAIN_URL = "file:///D:/app/renderer/dist/index.html";

async function setup() {
  const ctx = (await import("../../ipc/context")).default;
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  tracker.initArbiTracker();
  const arbiIpc = await import("../../ipc/arbiIpc");
  handlers.clear();
  arbiIpc.register();
  ctx.mainWindow = makeWindowStub(11);
  return { ctx, tracker };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbi-ipc-test-"));
});

afterEach(async () => {
  const ctx = (await import("../../ipc/context")).default;
  const tracker = await import("../../services/arbiRunTracker");
  tracker.__resetArbiTrackerForTest();
  ctx.mainWindow = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("arbi IPC", () => {
  it("registers all arbi channels", async () => {
    await setup();
    for (const channel of [
      "arbi:get-runs",
      "arbi:set-vitus",
      "arbi:delete-run",
      "arbi:delete-log",
      "arbi:export-log",
      "arbi:import-log",
      "arbi:save-image",
      "arbi:show-log-in-folder",
    ]) {
      expect(handlers.get(channel), channel).toBeTypeOf("function");
    }
  });

  it("rejects unauthorized senders", async () => {
    await setup();
    const badEvent = makeEvent(99, MAIN_URL);
    await expect(handlers.get("arbi:get-runs")?.(badEvent)).rejects.toThrow(
      "Unauthorized IPC sender",
    );
  });

  it("returns runs payload for the authorized sender", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    const payload = (await handlers.get("arbi:get-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };
    expect(payload.runs).toEqual([]);
    expect(payload.diskUsageBytes).toBe(0);
  });

  it("validates set-vitus arguments", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    const setVitus = handlers.get("arbi:set-vitus") as Handler;
    expect(await setVitus(event, 123, 10)).toBeNull();
    expect(await setVitus(event, "unknown-id", 10)).toBeNull();
    expect(await setVitus(event, "x".repeat(65), 10)).toBeNull();
    expect(await setVitus(event, "some-id", -5)).toBeNull();
    expect(await setVitus(event, "some-id", Number.NaN)).toBeNull();
    expect(await setVitus(event, "some-id", "1044")).toBeNull();
  });

  it("rejects invalid image payloads", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    const saveImage = handlers.get("arbi:save-image") as Handler;
    expect(await saveImage(event, "id", "not-bytes")).toEqual({ ok: false });
    expect(await saveImage(event, "id", new Uint8Array(0))).toEqual({ ok: false });
  });

  it("returns ok:false for delete/export on unknown runs", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    expect(await handlers.get("arbi:delete-run")?.(event, "nope")).toEqual({ ok: false });
    expect(await handlers.get("arbi:delete-log")?.(event, "nope")).toBeNull();
    expect(await handlers.get("arbi:export-log")?.(event, "nope")).toEqual({ ok: false });
    expect(await handlers.get("arbi:show-log-in-folder")?.(event, "nope")).toEqual({ ok: false });
  });
});
