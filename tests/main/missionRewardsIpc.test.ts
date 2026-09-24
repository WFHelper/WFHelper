import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MISSION_REWARDS_GET,
  MISSION_REWARDS_PAGE,
  MISSION_REWARDS_UPDATED,
} from "../../config/shared/ipcChannels";
import type {
  MissionRewardsPage,
  MissionRewardsPayload,
} from "../../config/shared/missionRewardsTypes";
import { PLASTIDS, inventory, memoryRead } from "./missionRewardsFixtures";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type LineListener = (line: string, source: "dbwin" | "file") => void;
type InventoryListener = (data: Record<string, unknown>) => void;

const h = vi.hoisted(() => ({
  tmpDir: "",
  handlers: new Map<string, { guard: unknown; handler: Handler }>(),
  assertMainRendererSender: vi.fn(),
  broadcast: vi.fn(),
  readGameInventory: vi.fn(),
  listeners: new Set<(line: string, source: "dbwin" | "file") => void>(),
  inventoryListeners: new Set<(data: Record<string, unknown>) => void>(),
  context: {
    currentInventoryData: null as Record<string, unknown> | null,
    overlaySettings: { missionTrackingEnabled: true },
  },
}));

vi.mock("electron", () => ({ app: { getPath: () => h.tmpDir } }));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertMainRendererSender: h.assertMainRendererSender,
  handleAuthorized: (channel: string, guard: unknown, handler: Handler) => {
    h.handlers.set(channel, { guard, handler });
  },
}));
vi.mock("../../ipc/context", () => ({ default: h.context }));
vi.mock("../../ipc/inventoryIpc", () => ({
  addInventoryListener: (listener: InventoryListener) => {
    h.inventoryListeners.add(listener);
    return () => h.inventoryListeners.delete(listener);
  },
}));
vi.mock("../../ipc/popoutIpc", () => ({ broadcastToRenderers: h.broadcast }));
vi.mock("../../services/gameMemoryInventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/gameMemoryInventory")>()),
  readGameInventory: h.readGameInventory,
}));
vi.mock("../../services/win32Process", () => ({
  enumProcessIds: () => [],
  exePathOfPid: () => null,
  isWarframeExePath: () => false,
}));
// Factory mock: the real monitor pulls in chokidar and the koffi-backed DBWIN worker.
vi.mock("../../services/eeLogMonitor", () => ({
  addLineListener: (listener: LineListener) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
  isMissionEndLine: (line: string) => line.includes("EOM missionLocationUnlocked="),
}));
vi.mock("../../services/regionNames", () => ({
  loadRegionTranslation: () => ({ regions: {}, dict: {} }),
  nodeLabel: (_translation: unknown, node: string) => `${node} label`,
}));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import * as missionRewardsIpc from "../../ipc/missionRewardsIpc";

const EOM = "1281.547 Sys [Info]: EOM missionLocationUnlocked=1";
const LATER_EOM = "1341.547 Sys [Info]: EOM missionLocationUnlocked=1";
const SYNC =
  "1269.269 Sys [Info]: SyncAutoPopulatedConsumables for mission MT_SURVIVAL with location SolNode25";

function freshRead(plastids: number) {
  return memoryRead(inventory(plastids, Date.now() + 5_000));
}

function emit(line: string, source: "dbwin" | "file"): void {
  for (const listener of h.listeners) listener(line, source);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const entry = h.handlers.get(channel);
  if (!entry) throw new Error(`${channel} not registered`);
  return (await entry.handler({}, ...args)) as T;
}

/** Ends a mission and lets the memory read 3 s later run. */
async function endMission(): Promise<void> {
  emit(SYNC, "file");
  emit(EOM, "file");
  await vi.advanceTimersByTimeAsync(3_000);
}

/** Tracking on no longer scans memory; only a mission end does. */
async function registerIpc(): Promise<void> {
  h.readGameInventory.mockReset();
  h.readGameInventory.mockImplementation(async () => freshRead(13));
  missionRewardsIpc.register();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.readGameInventory).not.toHaveBeenCalled();
}

beforeEach(async () => {
  h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-rewards-ipc-"));
  h.handlers.clear();
  h.listeners.clear();
  h.inventoryListeners.clear();
  h.broadcast.mockClear();
  h.context.overlaySettings.missionTrackingEnabled = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
  h.context.currentInventoryData = inventory(10, Date.now() - 600_000);
  await registerIpc();
});

afterEach(() => {
  missionRewardsIpc.stop();
  vi.useRealTimers();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
});

describe("missionRewardsIpc", () => {
  it("guards both read channels with the main renderer check", () => {
    expect(h.handlers.get(MISSION_REWARDS_GET)?.guard).toBe(h.assertMainRendererSender);
    expect(h.handlers.get(MISSION_REWARDS_PAGE)?.guard).toBe(h.assertMainRendererSender);
  });

  it("reads after a file-only mission end when DBWIN missed it and pushes the labelled summary", async () => {
    await endMission();

    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    const payload = await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET);
    expect(payload.summaries[0]).toMatchObject({
      missionType: "MT_SURVIVAL",
      node: "SolNode25",
      nodeLabel: "SolNode25 label",
      items: [{ uniqueName: PLASTIDS, count: 3 }],
    });
    const pushes = h.broadcast.mock.calls.filter(
      ([channel]) => channel === MISSION_REWARDS_UPDATED,
    );
    expect(pushes.at(-1)?.[1]).toEqual(payload);
  });

  it("answers a page query with labels and rejects a malformed one", async () => {
    await endMission();
    const page = await invoke<MissionRewardsPage>(MISSION_REWARDS_PAGE, {
      offset: 0,
      limit: 10,
      uniqueNames: [PLASTIDS],
    });
    expect(page.matched).toBe(1);
    expect(page.latest?.nodeLabel).toBe("SolNode25 label");
    expect(page.summaries[0]?.nodeLabel).toBe("SolNode25 label");
    expect(page.totals.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);
    expect(page.status.phase).toBe("idle");
    await expect(invoke(MISSION_REWARDS_PAGE, { offset: "0" })).resolves.toBeNull();
  });

  it("hands regular inventory loads to the tracker", async () => {
    h.readGameInventory.mockImplementation(async () => memoryRead(null));
    await endMission();
    await vi.advanceTimersByTimeAsync(60_000);
    for (const listener of h.inventoryListeners) listener(inventory(16, Date.now()));
    expect((await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET)).summaries).toHaveLength(1);
  });

  it("reads 3 s after a DBWIN end and ignores the file's echo of it", async () => {
    emit(SYNC, "dbwin");
    emit(EOM, "dbwin");
    await vi.advanceTimersByTimeAsync(2_000);
    emit(SYNC, "file");
    emit(`${EOM}\r\n`, "file");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    emit(EOM, "file");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    const payload = await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET);
    expect(payload.summaries).toHaveLength(1);
    expect(payload.summaries[0]).toMatchObject({ missionCount: 1, node: "SolNode25" });
    expect(payload.status).toEqual({ phase: "idle", pendingMissions: 0 });
  });

  it("ignores the file echo when the DBWIN text lacks the uptime stamp", async () => {
    emit("Sys [Info]: EOM missionLocationUnlocked=1", "dbwin");
    await vi.advanceTimersByTimeAsync(2_000);
    emit(EOM, "file");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect((await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET)).summaries).toHaveLength(1);
  });

  it("counts a later file-only end after a DBWIN end as a second mission", async () => {
    emit(EOM, "dbwin");
    await vi.advanceTimersByTimeAsync(60_000);
    h.readGameInventory.mockImplementation(async () => freshRead(16));
    emit(LATER_EOM, "file");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    const payload = await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET);
    expect(payload.summaries).toHaveLength(2);
    expect(payload.summaries[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);
  });

  it("dates a late file-only end by the file's lag even after DBWIN lines", async () => {
    const start = Date.now();
    emit("1269.269 Script [Info]: Background load started", "file");
    await vi.advanceTimersByTimeAsync(20_000);
    emit("1289.269 Sys [Info]: Pause countdown done", "dbwin");
    emit("1270.269 Sys [Info]: EOM missionLocationUnlocked=1", "file");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    const payload = await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET);
    expect(payload.summaries[0]?.endedAt).toBe(start + 1_000);
  });

  it("tracks missions without the helper source or automatic sync", async () => {
    h.context.currentInventoryData = null;
    await endMission();
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect((await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET)).status).not.toHaveProperty(
      "blocked",
    );
  });

  it("starts with tracking off when the saved settings leave it off", async () => {
    missionRewardsIpc.stop();
    h.context.overlaySettings.missionTrackingEnabled = false;
    await registerIpc();
    await endMission();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    expect((await invoke<MissionRewardsPayload>(MISSION_REWARDS_GET)).status.blocked).toBe(
      "tracking-off",
    );
  });

  it("stops listening to EE.log lines and inventory loads once stopped", () => {
    missionRewardsIpc.stop();
    expect(h.listeners.size).toBe(0);
    expect(h.inventoryListeners.size).toBe(0);
  });
});
