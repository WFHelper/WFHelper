import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/userDataPath", () => ({
  userDataPath: (file: string) => path.join(tmpDir, file),
}));

// Mirror WFM: it echoes back the deadline it derived from `duration`.
const setStatus = vi.fn(async (status: string, duration: number | null) => ({
  status,
  statusUntil: duration ? new Date(Date.now() + duration * 1000).toISOString() : null,
}));
const getToken = vi.fn(() => "token" as string | null);
const getPublicStatus = vi.fn(async () => null as string | null);

vi.mock("../../services/wfmSession", () => ({
  setStatus: (status: string, duration: number | null) => setStatus(status, duration),
  getToken: () => getToken(),
  getPublicStatus: () => getPublicStatus(),
}));

type Presence = typeof import("../../services/wfmPresence");

async function freshPresence(): Promise<Presence> {
  vi.resetModules();
  setStatus.mockClear();
  getToken.mockReturnValue("token");
  return import("../../services/wfmPresence");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-presence-"));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("wfmPresence hold duration", () => {
  it("asks WFM to expire the status instead of running the clock locally", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 30 });

    await presence.setManualStatus("online");

    expect(setStatus).toHaveBeenCalledWith("online", 1800);
    expect(presence.getState().expiresAt).toBe(Date.now() + 1800_000);
  });

  it("sends no duration for invisible or a zero hold", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 30 });

    await presence.setManualStatus("invisible");
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
    expect(presence.getState().expiresAt).toBeNull();

    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 0 });
    await presence.setManualStatus("online");
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState().expiresAt).toBeNull();
  });

  it("re-sends the status when the duration changes, as the site does", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 30 });
    await presence.setManualStatus("online");

    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 60 });
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", 3600);
    expect(presence.getState().expiresAt).toBe(Date.now() + 3600_000);
  });

  it("settles to invisible locally once the deadline passes", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 30 });
    await presence.setManualStatus("online");
    setStatus.mockClear();

    await vi.advanceTimersByTimeAsync(1800_000);
    expect(presence.getState()).toMatchObject({ status: "invisible", expiresAt: null });
    // WFM already dropped it - we must not send a redundant set.
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe("wfmPresence server pushes", () => {
  it("adopts the status and deadline WFM announces", async () => {
    const presence = await freshPresence();
    const until = new Date(Date.now() + 600_000).toISOString();

    presence.applyServerStatus({ status: "ingame", statusUntil: until });

    expect(presence.getState()).toMatchObject({
      status: "ingame",
      expiresAt: Date.parse(until),
    });
  });

  it("ignores payloads that carry no usable status", async () => {
    const presence = await freshPresence();
    presence.applyServerStatus({ status: "offline" });
    presence.applyServerStatus(null);

    expect(presence.getState().status).toBeNull();
  });
});

describe("wfmPresence status changed elsewhere", () => {
  it("puts back the status the website set during an away hold", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("online");
    presence.syncIdle(0);

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);

    // The user picked a status on warframe.market while the hold was running.
    presence.applyServerStatus({ status: "ingame" });

    presence.syncIdle(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);
  });

  it("keeps the restore target when the push is only our own echo", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("online");
    presence.syncIdle(0);

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    presence.applyServerStatus({ status: "invisible" });

    presence.syncIdle(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
  });
});

describe("wfmPresence auto in-game", () => {
  it("sets ingame on game launch and restores the previous status on exit", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    await presence.setManualStatus("online");

    await presence.syncGameRunning(true);
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);
    expect(presence.getState()).toMatchObject({ status: "ingame", autoActive: true });

    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState()).toMatchObject({ status: "online", autoActive: false });
  });

  it("stays put while the toggle is off", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 0 });
    await presence.setManualStatus("invisible");
    setStatus.mockClear();

    await presence.syncGameRunning(true);
    expect(setStatus).not.toHaveBeenCalled();
    expect(presence.getState().status).toBe("invisible");
  });

  it("restores the status when the toggle is switched off mid-game", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    await presence.setManualStatus("online");
    await presence.syncGameRunning(true);

    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState()).toMatchObject({ status: "online", autoActive: false });
  });

  it("holds the auto status open-ended, then re-applies the hold on game exit", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 30 });
    await presence.setManualStatus("online");

    await presence.syncGameRunning(true);
    // The game running is the bound, so it must not expire mid-session.
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);
    expect(presence.getState().expiresAt).toBeNull();

    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("online", 1800);
    expect(presence.getState().expiresAt).toBe(Date.now() + 1800_000);
  });

  it("hides rather than guessing when the pre-launch status is unknown", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });

    await presence.syncGameRunning(true);
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);

    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("does not restore the stale ingame a previous run left behind", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    // A crashed run's auto push never expires, so the profile still says ingame.
    presence.applyServerStatus({ status: "ingame" });

    await presence.syncGameRunning(true);
    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("does nothing while logged out", async () => {
    const presence = await freshPresence();
    getToken.mockReturnValue(null);
    setStatus.mockClear();

    await presence.syncGameRunning(true);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("keeps the override alive when the restore push fails, and retries it", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    await presence.setManualStatus("online");
    await presence.syncGameRunning(true);

    setStatus.mockRejectedValueOnce(new Error("wfm unreachable"));
    await presence.syncGameRunning(false);
    // A dropped restore must not strand the account on ingame with nothing to put back.
    expect(presence.getState()).toMatchObject({ status: "ingame", autoActive: true });

    // The polls only call in on an edge, so the retry has to be self-scheduled.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(presence.getState()).toMatchObject({ status: "ingame", autoActive: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState()).toMatchObject({ status: "online", autoActive: false });
  });
});

const AWAY_IDLE = { autoIngameEnabled: false, holdMinutes: 0, awayIdleEnabled: true };
const AWAY_CLOSED = { autoIngameEnabled: false, holdMinutes: 0, awayWhenClosedEnabled: true };

describe("wfmPresence away while idle", () => {
  it("hides on the idle edge and puts the status back on activity", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("online");
    // The manual pick disarms the rule; the first idle edge arms it again.
    presence.syncIdle(0);

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
    expect(presence.getState()).toMatchObject({ status: "invisible", awayActive: true });

    presence.syncIdle(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState()).toMatchObject({ status: "online", awayActive: false });
  });

  it("waits for the configured delay and clamps it to 1-60 minutes", async () => {
    const presence = await freshPresence();
    presence.setOptions({ ...AWAY_IDLE, awayIdleMinutes: 999 });
    await presence.setManualStatus("online");
    presence.syncIdle(0);
    setStatus.mockClear();

    presence.syncIdle(59 * 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).not.toHaveBeenCalled();

    presence.syncIdle(60 * 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("leaves a manual invisible alone", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("invisible");
    presence.syncIdle(0);
    setStatus.mockClear();

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).not.toHaveBeenCalled();
    expect(presence.getState().awayActive).toBe(false);
  });

  it("stays out of the way while auto in-game holds the running game", async () => {
    const presence = await freshPresence();
    presence.setOptions({ ...AWAY_IDLE, autoIngameEnabled: true });
    await presence.setManualStatus("online");
    await presence.syncGameRunning(true);
    setStatus.mockClear();

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).not.toHaveBeenCalled();
    expect(presence.getState()).toMatchObject({ status: "ingame", autoActive: true });
  });

  it("still applies while the game runs with auto in-game off", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("online");
    await presence.syncGameRunning(true);

    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("re-arms only on the next idle edge after a manual pick", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);

    // Picking a status while still idle must not be overridden right back.
    await presence.setManualStatus("online");
    setStatus.mockClear();
    presence.syncIdle(700);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).not.toHaveBeenCalled();

    presence.syncIdle(0);
    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("releases the hold when the switch is turned off", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_IDLE);
    await presence.setManualStatus("online");
    presence.syncIdle(0);
    presence.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);

    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState().awayActive).toBe(false);
  });

  it("only samples idle time while the idle rule is on", async () => {
    const presence = await freshPresence();
    expect(presence.needsIdlePolling()).toBe(false);
    presence.setOptions(AWAY_IDLE);
    expect(presence.needsIdlePolling()).toBe(true);
  });
});

describe("wfmPresence away while Warframe is closed", () => {
  it("hides on game exit and hands over to auto in-game on the next launch", async () => {
    const presence = await freshPresence();
    presence.setOptions({ ...AWAY_CLOSED, autoIngameEnabled: true });
    await presence.setManualStatus("online");

    await presence.syncGameRunning(true);
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);

    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
    expect(presence.getState()).toMatchObject({ awayActive: true, autoActive: false });

    await presence.syncGameRunning(true);
    expect(setStatus).toHaveBeenLastCalledWith("ingame", null);
    expect(presence.getState()).toMatchObject({ awayActive: false, autoActive: true });

    // The status the away hold carried through survives to the final restore.
    presence.setOptions({ autoIngameEnabled: false, holdMinutes: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
  });

  it("restores the replaced status on launch when auto in-game is off", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_CLOSED);
    await presence.setManualStatus("online");
    // Arm the rule on a game-state edge, the way the status poll does.
    await presence.syncGameRunning(true);
    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);

    await presence.syncGameRunning(true);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState()).toMatchObject({ status: "online", awayActive: false });
  });

  it("leaves the game-exit restore alone while the switch is off", async () => {
    const presence = await freshPresence();
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    await presence.setManualStatus("online");

    await presence.syncGameRunning(true);
    await presence.syncGameRunning(false);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(presence.getState().awayActive).toBe(false);
  });

  it("drops the hold when the user picks a status by hand", async () => {
    const presence = await freshPresence();
    presence.setOptions(AWAY_CLOSED);
    await presence.setManualStatus("online");
    await presence.syncGameRunning(true);
    await presence.syncGameRunning(false);
    expect(presence.getState().awayActive).toBe(true);

    await presence.setManualStatus("online");
    expect(presence.getState().awayActive).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
  });
});

describe("wfmPresence away across restarts", () => {
  it("reclaims an away invisible a previous run left and restores it", async () => {
    const first = await freshPresence();
    first.setOptions(AWAY_IDLE);
    await first.setManualStatus("online");
    first.syncIdle(0);
    first.syncIdle(600);
    await vi.advanceTimersByTimeAsync(0);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);

    // The app quits while away; the account stays invisible until the next run.
    const next = await freshPresence();
    getPublicStatus.mockResolvedValueOnce("invisible");
    next.setOptions(AWAY_IDLE);
    await next.refreshFromServer();
    expect(next.getState().awayActive).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(setStatus).toHaveBeenLastCalledWith("online", null);
    expect(next.getState()).toMatchObject({ status: "online", awayActive: false });
  });

  it("still reclaims an auto flag written before away was persisted", async () => {
    fs.writeFileSync(path.join(tmpDir, "wfm-presence.json"), JSON.stringify({ autoActive: true }));
    const presence = await freshPresence();
    getPublicStatus.mockResolvedValueOnce("ingame");
    presence.setOptions({ autoIngameEnabled: true, holdMinutes: 0 });
    await presence.refreshFromServer();
    expect(presence.getState().autoActive).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(setStatus).toHaveBeenLastCalledWith("invisible", null);
  });

  it("leaves a hand-picked invisible alone on the next run", async () => {
    const presence = await freshPresence();
    getPublicStatus.mockResolvedValueOnce("invisible");
    presence.setOptions(AWAY_IDLE);
    await presence.refreshFromServer();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(presence.getState().awayActive).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });
});
