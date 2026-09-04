import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEvent, makeWindowStub } from "./senderGuardHelpers";
import { forceEeLogPoll } from "../../services/eeLogMonitor";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
let tmpDir: string;

// Factory mock, not importOriginal: the real module pulls in chokidar and the
// koffi-backed DBWIN worker just to stub one exported function.
vi.mock("../../services/eeLogMonitor", () => ({ forceEeLogPoll: vi.fn() }));

const forceEeLogPollMock = vi.mocked(forceEeLogPoll);

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

const PT_CHANNELS = [
  "pt:get-runs",
  "pt:refresh-runs",
  "pt:set-tags",
  "pt:set-notes",
  "pt:delete-run",
  "pt:delete-log",
  "pt:export-log",
  "pt:import-log",
  "pt:show-log-in-folder",
] as const;

const FIXTURE = path.join(__dirname, "..", "fixtures", "pt", "host-single-run.log");

async function setup() {
  const ctx = (await import("../../ipc/context")).default;
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  tracker.initPtTracker();
  const profitTakerIpc = await import("../../ipc/profitTakerIpc");
  handlers.clear();
  profitTakerIpc.register();
  ctx.mainWindow = makeWindowStub(11);
  return { ctx, tracker };
}

function feedFixture(tracker: typeof import("../../services/profitTakerTracker")): void {
  for (const line of fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/)) {
    tracker.processProfitTakerLine(line, "file");
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ipc-test-"));
  forceEeLogPollMock.mockReset();
});

afterEach(async () => {
  const ctx = (await import("../../ipc/context")).default;
  const tracker = await import("../../services/profitTakerTracker");
  tracker.__resetPtTrackerForTest();
  ctx.mainWindow = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("profit-taker IPC", () => {
  it("registers all Profit-Taker channels", async () => {
    await setup();
    for (const channel of PT_CHANNELS) {
      expect(handlers.get(channel), channel).toBeTypeOf("function");
    }
  });

  it("rejects unauthorized senders on every channel", async () => {
    await setup();
    const badEvent = makeEvent(99, MAIN_URL);
    for (const channel of PT_CHANNELS) {
      await expect(handlers.get(channel)?.(badEvent), channel).rejects.toThrow(
        "Unauthorized IPC sender",
      );
    }
  });

  it("returns runs payload for the authorized sender", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    const payload = (await handlers.get("pt:get-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };
    expect(payload.runs).toEqual([]);
    expect(payload.diskUsageBytes).toBe(0);
  });

  it("validates set-notes arguments and sanitises the text", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);
    const setNotes = handlers.get("pt:set-notes") as Handler;
    expect(await setNotes(event, 123, "hi")).toBeNull();
    expect(await setNotes(event, "x".repeat(65), "hi")).toBeNull();
    expect(await setNotes(event, "unknown-id", "hi")).toBeNull();

    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    const [run] = tracker.getPtRuns();

    const saved = (await setNotes(event, run.id, "  line\u0001 one  ")) as { notes?: string };
    expect(saved.notes).toBe("line one");
    const cleared = (await setNotes(event, run.id, { evil: true })) as { notes?: string };
    expect(cleared.notes).toBeUndefined();
  });

  it("validates set-tags arguments", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);
    const setTags = handlers.get("pt:set-tags") as Handler;
    expect(await setTags(event, 123, ["a"])).toBeNull();
    expect(await setTags(event, "unknown-id", ["a"])).toBeNull();

    feedFixture(tracker);
    await tracker.awaitPendingPtSaves();
    const [run] = tracker.getPtRuns();
    const saved = (await setTags(event, run.id, ["  sub 2 ", "not-a-string", 7])) as {
      tags?: string[];
    };
    expect(saved.tags).toEqual(["sub 2", "not-a-string"]);
    // Non-array input is coerced to empty, which clears the tags.
    const cleared = (await setTags(event, run.id, "nope")) as { tags?: string[] };
    expect(cleared.tags).toBeUndefined();
  });

  it("returns ok:false for delete/export on unknown runs", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    expect(await handlers.get("pt:delete-run")?.(event, "nope")).toEqual({ ok: false });
    expect(await handlers.get("pt:delete-log")?.(event, "nope")).toBeNull();
    expect(await handlers.get("pt:export-log")?.(event, "nope")).toEqual({ ok: false });
    expect(await handlers.get("pt:show-log-in-folder")?.(event, "nope")).toEqual({ ok: false });
  });

  it("refresh forces an EE.log poll, awaits pending saves, and matches get-runs' payload shape", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);
    feedFixture(tracker);

    const refreshPayload = (await handlers.get("pt:refresh-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };

    expect(forceEeLogPollMock).toHaveBeenCalledTimes(1);
    expect(refreshPayload.runs).toHaveLength(1);

    const getRunsPayload = await handlers.get("pt:get-runs")?.(event);
    expect(refreshPayload).toEqual(getRunsPayload);
  });

  it("still returns the current runs when the forced poll throws", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    forceEeLogPollMock.mockImplementation(() => {
      throw new Error("poll boom");
    });

    const payload = (await handlers.get("pt:refresh-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };
    expect(payload.runs).toEqual([]);
    expect(payload.diskUsageBytes).toBe(0);
  });

  it("import returns an empty result when the file dialog is cancelled", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    expect(await handlers.get("pt:import-log")?.(event)).toEqual({ imported: [], skipped: 0 });
  });
});
