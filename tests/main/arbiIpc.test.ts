import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEvent, makeWindowStub } from "./senderGuardHelpers";
import { forceEeLogPoll } from "../../services/eeLogMonitor";
import type {
  ArbiImportResult,
  ArbiRunRecord,
  ArbiRunsPayload,
} from "../../config/shared/arbiTypes";
import type { PtImportResult, PtRunsPayload } from "../../config/shared/profitTakerTypes";

const noop = (): void => undefined;

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

const ARBI_CHANNELS = [
  "arbi:get-runs",
  "arbi:refresh-runs",
  "arbi:set-vitus",
  "arbi:set-tags",
  "arbi:set-notes",
  "arbi:delete-run",
  "arbi:delete-log",
  "arbi:export-log",
  "arbi:import-log",
  "arbi:save-image",
  "arbi:show-log-in-folder",
] as const;

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

const missionLine = (ts: number, name: string) =>
  `${ts.toFixed(3)} Script [Info]: ThemedSquadOverlay.lua: Mission name: ${name}`;
const droneLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent7`;
const rewardLine = (ts: number) =>
  `${ts.toFixed(3)} Sys [Info]: Created /Lotus/Interface/DefenseReward.swf`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbi-ipc-test-"));
  forceEeLogPollMock.mockReset();
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
    for (const channel of ARBI_CHANNELS) {
      expect(handlers.get(channel), channel).toBeTypeOf("function");
    }
  });

  it("rejects unauthorized senders on every channel", async () => {
    await setup();
    const badEvent = makeEvent(99, MAIN_URL);
    for (const channel of ARBI_CHANNELS) {
      await expect(handlers.get(channel)?.(badEvent), channel).rejects.toThrow(
        "Unauthorized IPC sender",
      );
    }
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

  it("validates set-notes arguments and sanitises the text", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);
    const setNotes = handlers.get("arbi:set-notes") as Handler;
    expect(await setNotes(event, 123, "hi")).toBeNull();
    expect(await setNotes(event, "x".repeat(65), "hi")).toBeNull();
    expect(await setNotes(event, "unknown-id", "hi")).toBeNull();

    tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
    tracker.processArbiLine(droneLine(150), "file");
    tracker.processArbiLine(rewardLine(400), "file");
    tracker.processArbiLine(rewardLine(500), "file");
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");
    await tracker.awaitPendingArbiSaves();
    const [run] = tracker.getRuns();

    const saved = (await setNotes(event, run.id, "  line\u0001 one  ")) as { notes?: string };
    expect(saved.notes).toBe("line one");
    // Non-string input is coerced to empty, which clears the note.
    const cleared = (await setNotes(event, run.id, { evil: true })) as { notes?: string };
    expect(cleared.notes).toBeUndefined();
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

  it("refresh forces an EE.log poll, awaits pending saves, and matches get-runs' payload shape", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);

    // Two rotations feed the save gate; the trailing mission line ends the run via
    // the async gzip pipeline, so it is still in flight when refresh is invoked.
    tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
    tracker.processArbiLine(droneLine(150), "file");
    tracker.processArbiLine(droneLine(200), "file");
    tracker.processArbiLine(rewardLine(400), "file");
    tracker.processArbiLine(rewardLine(500), "file");
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");

    const refreshPayload = (await handlers.get("arbi:refresh-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };

    expect(forceEeLogPollMock).toHaveBeenCalledTimes(1);
    expect(refreshPayload.runs).toHaveLength(1);

    const getRunsPayload = await handlers.get("arbi:get-runs")?.(event);
    expect(refreshPayload).toEqual(getRunsPayload);
  });

  it("refresh still replies when the run-saved callback throws", async () => {
    const { tracker } = await setup();
    const event = makeEvent(11, MAIN_URL);
    tracker.setArbiCallbacks({
      onRunSaved: () => {
        throw new Error("webContents destroyed mid-send");
      },
    });

    tracker.processArbiLine(missionLine(100, "Arbitration: Casta Defense (Ceres)"), "file");
    tracker.processArbiLine(droneLine(150), "file");
    tracker.processArbiLine(droneLine(200), "file");
    tracker.processArbiLine(rewardLine(400), "file");
    tracker.processArbiLine(rewardLine(500), "file");
    tracker.processArbiLine(missionLine(900, "Cetus (Earth)"), "file");

    const payload = (await handlers.get("arbi:refresh-runs")?.(event)) as { runs: unknown[] };
    expect(payload.runs).toHaveLength(1);
  });

  it("still returns the current runs when the forced poll throws", async () => {
    await setup();
    const event = makeEvent(11, MAIN_URL);
    forceEeLogPollMock.mockImplementation(() => {
      throw new Error("poll boom");
    });

    const payload = (await handlers.get("arbi:refresh-runs")?.(event)) as {
      runs: unknown[];
      diskUsageBytes: number;
    };
    expect(payload.runs).toEqual([]);
    expect(payload.diskUsageBytes).toBe(0);
  });

  // Compile-time cover for the shared registrar: `tsc -p tsconfig.tests.json`
  // fails if a spec no longer matches the payload types the renderer is served.
  it("pins the shared spec to the arbi payload contract", () => {
    const register = (() =>
      undefined) as unknown as typeof import("../../ipc/runTrackerIpc").registerRunTrackerIpc;
    const runs: ArbiRunRecord[] = [];
    const spec = {
      log: { info: noop, warn: noop, error: noop, debug: noop, time: noop, timeEnd: noop },
      label: "[Arbi]",
      channels: {
        getRuns: "arbi:get-runs",
        refreshRuns: "arbi:refresh-runs",
        setTags: "arbi:set-tags",
        setNotes: "arbi:set-notes",
        deleteRun: "arbi:delete-run",
        deleteLog: "arbi:delete-log",
        exportLog: "arbi:export-log",
        importLog: "arbi:import-log",
        showLogInFolder: "arbi:show-log-in-folder",
      },
      tracker: {
        getRuns: () => runs,
        getDiskUsageBytes: () => 0,
        awaitPendingSaves: async () => undefined,
        setRunTags: () => runs[0] ?? null,
        setRunNotes: () => runs[0] ?? null,
        deleteRun: () => true,
        deleteRunLog: () => runs[0] ?? null,
        getRunLogPath: () => null,
      },
      importLog: async (): Promise<ArbiImportResult> => ({ imported: runs, skipped: 0 }),
      exportBaseName: (id: string) => id,
    };

    register<ArbiRunsPayload, ArbiImportResult>(spec);
    // @ts-expect-error - a Profit-Taker payload does not describe arbi runs
    register<PtRunsPayload, ArbiImportResult>(spec);
    // @ts-expect-error - the import result must carry the payload's own records
    register<ArbiRunsPayload, PtImportResult>(spec);

    expect(spec.channels.getRuns).toBe("arbi:get-runs");
  });
});
