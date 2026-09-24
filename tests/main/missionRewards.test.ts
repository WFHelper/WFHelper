import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GameInventoryRead } from "../../services/gameMemoryInventory";

let tmpDir = "";

vi.mock("electron", () => ({ app: { getPath: () => tmpDir } }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../services/win32Process", () => ({
  enumProcessIds: () => [],
  exePathOfPid: () => null,
  isWarframeExePath: () => false,
}));

import * as missionRewards from "../../services/missionRewards";
import { queryHistory } from "../../services/missionRewardsHistory";
import { PLASTIDS, inventory, memoryRead } from "./missionRewardsFixtures";

const READ_DELAY_MS = 3_000;
const RETRY_DELAY_MS = 1_000;
const GAME_START = Date.parse("2026-09-20T11:00:00Z");

const RELIC = "/Lotus/Types/Game/Projections/T1VoidProjectionTestBronze";

/** An EE.log line stamped with the game uptime of the current fake clock. */
function line(text: string): string {
  return `${((Date.now() - GAME_START) / 1000).toFixed(3)} ${text}`;
}

const EOM = () => line("Sys [Info]: EOM missionLocationUnlocked=1");
const ABORT = () => line("Script [Info]: TopMenu.lua: Abort: mission failed");
const HUB_ABORT = () => line("Script [Info]: TopMenu.lua: Abort: in hub (1)");
const SYNC_DONE = () => line("Script [Info]: Hub.lua: Inventory sync done");
const RELOAD = () => line("Sys [Error]: Bad data from inventory.php:");
const SYNC_NODE = () =>
  line("Sys [Info]: SyncAutoPopulatedConsumables for mission MT_SURVIVAL with location SolNode25");
const SYNC_HUB = () =>
  line("Sys [Info]: SyncAutoPopulatedConsumables for mission MT_PVP with location CetusHub4");

interface Harness {
  readGameInventory: ReturnType<typeof vi.fn<() => Promise<GameInventoryRead>>>;
  onChange: ReturnType<typeof vi.fn<() => void>>;
  setCurrent(value: unknown): void;
  setMemory(value: GameInventoryRead): void;
}

interface SetupOptions {
  current?: unknown;
  tracking?: boolean;
  /** How long each fake memory scan takes. */
  scanMs?: number;
}

async function setup({
  current = inventory(10, Date.now() - 600_000),
  tracking = true,
  scanMs = 0,
}: SetupOptions = {}): Promise<Harness> {
  let loaded = current;
  let memory = memoryRead(null);
  const readGameInventory = vi.fn<() => Promise<GameInventoryRead>>(async () => {
    if (scanMs > 0) await new Promise((resolve) => setTimeout(resolve, scanMs));
    return memory;
  });
  const onChange = vi.fn<() => void>();
  missionRewards.init({ currentInventory: () => loaded, readGameInventory, onChange });
  missionRewards.setTrackingEnabled(tracking);
  await vi.advanceTimersByTimeAsync(0);
  return {
    readGameInventory,
    onChange,
    setCurrent: (value) => (loaded = value),
    setMemory: (value) => (memory = value),
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Ends a mission and lets the read that follows it run. */
async function endMission(): Promise<number> {
  const endedAt = Date.now();
  missionRewards.onMissionEnd(EOM());
  await advance(READ_DELAY_MS);
  return endedAt;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-rewards-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
});

afterEach(() => {
  missionRewards.stop();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mission reward reads from game memory", () => {
  it("reads 3 s after the end and records a copy synced 5 s before it", async () => {
    const h = await setup();
    missionRewards.observeLine(SYNC_NODE());
    const endedAt = Date.now();
    h.setMemory(
      memoryRead({
        ...inventory(14, endedAt - 5_000, 26_000),
        MiscItems: [
          { ItemType: PLASTIDS, ItemCount: 14 },
          { ItemType: RELIC, ItemCount: 1 },
        ],
      }),
    );

    missionRewards.onMissionEnd(EOM());
    expect(missionRewards.getStatus().phase).toBe("waiting");
    await advance(READ_DELAY_MS - 1);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    await advance(1);

    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    const [summary] = missionRewards.getHistory();
    expect(summary).toMatchObject({
      endedAt,
      missionCount: 1,
      missionType: "MT_SURVIVAL",
      node: "SolNode25",
      credits: 25_000,
      endo: 0,
      items: [
        { uniqueName: RELIC, count: 1 },
        { uniqueName: PLASTIDS, count: 4 },
      ],
    });
    expect(missionRewards.getStatus()).toEqual({ phase: "idle", pendingMissions: 0 });
    expect(fs.existsSync(path.join(tmpDir, "mission-history.json"))).toBe(true);
  });

  it("retries once a second after an empty read, before the copy leaves memory", async () => {
    const h = await setup({ scanMs: 5_000 });
    const endedAt = Date.now();
    missionRewards.onMissionEnd(EOM());
    await advance(READ_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(missionRewards.getStatus().phase).toBe("reading");

    h.setMemory(memoryRead(inventory(15, endedAt - 4_000)));
    await advance(RETRY_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    expect(Date.now() - endedAt).toBeLessThan(10_000);
    await advance(5_000);
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 5 }]);
    expect(missionRewards.getStatus()).toEqual({ phase: "idle", pendingMissions: 0 });
    await advance(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
  });

  it("does not wait for the game's inventory sync or reload lines", async () => {
    const h = await setup();
    h.setMemory(memoryRead(inventory(13, Date.now() - 5_000)));
    missionRewards.onMissionEnd(EOM());
    missionRewards.observeLine(RELOAD());
    missionRewards.observeLine(SYNC_DONE());
    await advance(READ_DELAY_MS - 1);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    await advance(1);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);

    missionRewards.observeLine(RELOAD());
    missionRewards.observeLine(SYNC_DONE());
    await advance(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
  });

  it("reads at once when the file delivers the end line late", async () => {
    const h = await setup();
    missionRewards.observeLine(SYNC_NODE());
    const endedAt = Date.now();
    const eom = EOM();
    await advance(5_000);
    h.setMemory(memoryRead(inventory(12, endedAt - 5_000)));
    missionRewards.onMissionEnd(eom);
    await advance(0);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect(missionRewards.getHistory()[0]).toMatchObject({
      endedAt,
      items: [{ uniqueName: PLASTIDS, count: 2 }],
    });
  });

  it("gives the carried mission to the next regular inventory load", async () => {
    const h = await setup();
    const endedAt = await endMission();
    await advance(60_000);
    expect(missionRewards.getStatus()).toMatchObject({
      lastFailure: "no-fresh-copy",
      pendingMissions: 1,
    });

    missionRewards.onInventoryLoaded(inventory(10, endedAt - 600_000));
    expect(missionRewards.getHistory()).toEqual([]);

    missionRewards.onInventoryLoaded(inventory(17, endedAt + 400_000));
    expect(missionRewards.getHistory()[0]).toMatchObject({
      missionCount: 1,
      items: [{ uniqueName: PLASTIDS, count: 7 }],
    });
    expect(missionRewards.getStatus()).toEqual({ phase: "idle", pendingMissions: 0 });
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
  });

  it("does not retry while the game is not running", async () => {
    const h = await setup();
    h.setMemory(memoryRead(null, "process-not-found"));
    await endMission();
    await advance(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect(missionRewards.getStatus()).toMatchObject({
      lastFailure: "game-not-running",
      pendingMissions: 1,
    });
  });

  it("leaves a regular load during the wait to the memory read", async () => {
    const h = await setup();
    const endedAt = Date.now();
    missionRewards.onMissionEnd(EOM());
    missionRewards.onInventoryLoaded(inventory(13, endedAt + 2_000));
    expect(missionRewards.getHistory()).toEqual([]);
    h.setMemory(memoryRead(inventory(13, endedAt - 4_000)));
    await advance(READ_DELAY_MS);
    expect(missionRewards.getHistory()).toHaveLength(1);
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);
  });
});

describe("freshness", () => {
  it("never attributes a copy synced long before the end", async () => {
    const h = await setup({ current: inventory(10, null) });
    h.setMemory(memoryRead(inventory(10, Date.now() - 300_000)));
    missionRewards.onMissionEnd(EOM());
    await advance(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    expect(missionRewards.getHistory()).toEqual([]);
    expect(missionRewards.getStatus()).toEqual({
      phase: "idle",
      lastFailure: "no-fresh-copy",
      pendingMissions: 1,
    });
  });

  it("rejects a copy that is not newer than the baseline", async () => {
    const h = await setup();
    const loaded = inventory(12, Date.now() - 10_000);
    missionRewards.onInventoryLoaded(loaded);
    h.setMemory(memoryRead(loaded));
    missionRewards.onMissionEnd(EOM());
    await advance(60_000);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    expect(missionRewards.getHistory()).toEqual([]);
    expect(missionRewards.getStatus()).toMatchObject({
      lastFailure: "no-fresh-copy",
      pendingMissions: 1,
    });
  });

  it("keeps out a copy from a reload before the mission and takes the next one", async () => {
    const h = await setup();
    await advance(60_000);
    // A relay trade reloads the inventory a minute before the mission ends.
    h.setMemory(memoryRead(inventory(12, Date.now())));
    await advance(60_000);
    const endedAt = Date.now();
    missionRewards.onMissionEnd(EOM());
    await advance(READ_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect(missionRewards.getHistory()).toEqual([]);

    h.setMemory(memoryRead(inventory(15, endedAt - 5_000)));
    await advance(RETRY_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 5 }]);
  });
});

describe("mission ends", () => {
  it("joins an abort and the EOM of one mission into a single read after the EOM", async () => {
    const h = await setup();
    h.setMemory(memoryRead(inventory(11, Date.now() + 1_000)));
    missionRewards.onMissionEnd(ABORT());
    await advance(2_000);
    missionRewards.onMissionEnd(EOM());
    expect(missionRewards.getStatus().pendingMissions).toBe(1);
    await advance(READ_DELAY_MS - 1);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    await advance(1);
    expect(h.readGameInventory).toHaveBeenCalledTimes(1);
    expect(missionRewards.getHistory()).toHaveLength(1);
    expect(missionRewards.getHistory()[0]?.missionCount).toBe(1);
  });

  it("reads again for the EOM that follows its abort after the first reads failed", async () => {
    const h = await setup();
    missionRewards.onMissionEnd(ABORT());
    await advance(READ_DELAY_MS + RETRY_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
    expect(missionRewards.getStatus()).toMatchObject({ phase: "idle", pendingMissions: 1 });

    h.setMemory(memoryRead(inventory(12, Date.now())));
    missionRewards.onMissionEnd(EOM());
    expect(missionRewards.getStatus().phase).toBe("waiting");
    await advance(READ_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(3);
    expect(missionRewards.getHistory()[0]).toMatchObject({
      missionCount: 1,
      items: [{ uniqueName: PLASTIDS, count: 2 }],
    });
  });

  it("carries a mission whose read failed into the next one", async () => {
    const h = await setup();
    await endMission();
    await advance(60_000);
    const secondEnd = Date.now();
    h.setMemory(memoryRead(inventory(16, secondEnd - 5_000)));
    missionRewards.onMissionEnd(EOM());
    expect(missionRewards.getStatus().pendingMissions).toBe(2);
    await advance(READ_DELAY_MS);
    expect(h.readGameInventory).toHaveBeenCalledTimes(3);
    expect(missionRewards.getHistory()[0]).toMatchObject({
      missionCount: 2,
      endedAt: secondEnd,
    });
  });

  it("ignores an abort in a hub and a mission end logged in a town", async () => {
    const h = await setup();
    missionRewards.onMissionEnd(HUB_ABORT());
    missionRewards.observeLine(SYNC_HUB());
    missionRewards.onMissionEnd(EOM());
    await advance(60_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    expect(missionRewards.getStatus()).toEqual({ phase: "idle", pendingMissions: 0 });
  });

  it("does not carry one mission's info into the next", async () => {
    const h = await setup();
    missionRewards.observeLine(SYNC_NODE());
    h.setMemory(memoryRead(inventory(10, Date.now())));
    await endMission();
    await advance(60_000);
    h.setMemory(memoryRead(inventory(10, Date.now())));
    await endMission();
    const [latest, first] = missionRewards.getHistory();
    expect(first?.missionType).toBe("MT_SURVIVAL");
    expect(latest && "missionType" in latest).toBe(false);
  });

  it("drops a pending read when stopped", async () => {
    const h = await setup();
    missionRewards.onMissionEnd(EOM());
    missionRewards.stop();
    await advance(60_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
  });
});

describe("tracking switch", () => {
  it("does nothing at all while tracking is off, which is the default", async () => {
    const h = await setup({ tracking: false });
    h.setMemory(memoryRead(inventory(15, Date.now())));
    missionRewards.observeLine(SYNC_NODE());
    missionRewards.onMissionEnd(EOM());
    missionRewards.observeLine(SYNC_DONE());
    missionRewards.onInventoryLoaded(inventory(20, Date.now() + 5_000));
    await advance(120_000);

    expect(h.readGameInventory).not.toHaveBeenCalled();
    expect(missionRewards.getHistory()).toEqual([]);
    expect(missionRewards.getStatus()).toEqual({
      phase: "idle",
      blocked: "tracking-off",
      pendingMissions: 0,
    });
    expect(fs.existsSync(path.join(tmpDir, "mission-history.json"))).toBe(false);
  });

  it("starts from the inventory loaded when it is turned on, without a memory scan", async () => {
    const h = await setup({ tracking: false });
    h.setCurrent(inventory(30, Date.now() - 60_000));
    missionRewards.setTrackingEnabled(true);
    await advance(60_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    h.setMemory(memoryRead(inventory(33, Date.now())));
    await endMission();
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);
  });

  it("drops a mission in flight when it is turned off", async () => {
    const h = await setup();
    missionRewards.onMissionEnd(EOM());
    missionRewards.setTrackingEnabled(false);
    await advance(60_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
    expect(missionRewards.getStatus().pendingMissions).toBe(0);
  });
});

describe("baselines", () => {
  it("takes the first read as the baseline when no inventory was loaded", async () => {
    const h = await setup({ current: null });
    h.setMemory(memoryRead(inventory(10, Date.now())));
    await endMission();
    expect(missionRewards.getHistory()).toEqual([]);

    await advance(60_000);
    h.setMemory(memoryRead(inventory(13, Date.now())));
    await endMission();
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 3 }]);
  });

  it("moves the baseline to a regular load between missions", async () => {
    const h = await setup();
    missionRewards.onInventoryLoaded(inventory(110, Date.now() - 60_000));
    missionRewards.onInventoryLoaded(inventory(50, Date.now() - 120_000));
    h.setMemory(memoryRead(inventory(115, Date.now())));
    await endMission();
    expect(missionRewards.getHistory()[0]?.items).toEqual([{ uniqueName: PLASTIDS, count: 5 }]);
  });

  it("records an empty summary when the mission brought nothing", async () => {
    const h = await setup();
    h.setMemory(memoryRead(inventory(10, Date.now())));
    await endMission();
    expect(missionRewards.getHistory()[0]).toMatchObject({ items: [], credits: 0, endo: 0 });
  });

  it("never scans memory without a pending mission", async () => {
    const h = await setup({ current: null });
    h.setMemory(memoryRead(inventory(10, Date.now())));
    missionRewards.observeLine(RELOAD());
    missionRewards.observeLine(SYNC_DONE());
    await advance(60_000);
    missionRewards.observeLine(RELOAD());
    await advance(60_000);
    expect(h.readGameInventory).not.toHaveBeenCalled();
  });

  it("never counts a load without a sync time as a mission's rewards", async () => {
    const h = await setup();
    await endMission();
    await advance(60_000);
    missionRewards.onInventoryLoaded(inventory(99, null));
    expect(missionRewards.getHistory()).toEqual([]);
    expect(missionRewards.getStatus().pendingMissions).toBe(1);
    expect(h.readGameInventory).toHaveBeenCalledTimes(2);
  });
});

describe("history", () => {
  it("keeps every mission across a restart and hands the widget the newest ten", async () => {
    const h = await setup();
    for (let i = 0; i < 12; i += 1) {
      h.setMemory(memoryRead(inventory(10 + i + 1, Date.now())));
      await endMission();
      await advance(60_000);
    }
    missionRewards.stop();
    await setup();

    expect(missionRewards.getHistory()).toHaveLength(10);
    expect(queryHistory({ offset: 0, limit: 50 }).recorded).toBe(12);
  });
});
