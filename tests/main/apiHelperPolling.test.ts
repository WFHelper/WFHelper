import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  running: false as boolean | null,
  userData: "",
  info: vi.fn(),
  nativeScan: vi.fn(async () => ({ authz: null, reason: "process-not-found" })),
  spawn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData, isPackaged: false },
}));
vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: h.info, warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../services/gameMemoryWin", () => ({ readGameAuthzWin: h.nativeScan }));
vi.mock("../../services/warframeStatus", () => ({
  getWarframeProcessState: () => h.running,
  isWarframeRunningCached: () => h.running,
}));

type Runner = typeof import("../../services/apiHelperRunner");

const realPlatform = process.platform;
const INTERVAL = 600_000;
const RETRY = 90_000;
h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-helper-poll-"));
let runner: Runner;

function loggedWaiting(): number {
  return h.info.mock.calls.filter(([line]) => String(line).startsWith("Warframe is not running"))
    .length;
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  h.running = false;
  runner = await import("../../services/apiHelperRunner");
});

afterEach(() => {
  runner.stopPolling();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

afterAll(() => {
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe("helper polling while Warframe is closed", () => {
  it("settles scheduled runs as game-not-running without starting the helper", async () => {
    runner.startPolling(INTERVAL);
    await vi.advanceTimersByTimeAsync(RETRY * 4);
    expect(h.nativeScan).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(runner.getStatus()).toMatchObject({
      running: false,
      lastRunOk: false,
      lastRunReason: "game-not-running",
    });
    expect(loggedWaiting()).toBe(1);
    expect(h.info.mock.calls.some(([line]) => String(line).includes("retrying in"))).toBe(false);
  });

  it("runs on the first poll after the game starts", async () => {
    runner.startPolling(INTERVAL);
    await vi.advanceTimersByTimeAsync(RETRY);
    h.running = true;
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(h.nativeScan).toHaveBeenCalledOnce();
  });

  it("still runs when the game state is unknown", async () => {
    h.running = null;
    runner.startPolling(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.nativeScan).toHaveBeenCalledOnce();
    expect(loggedWaiting()).toBe(0);
  });

  it("keeps the fast fetch after a game login", async () => {
    runner.startPolling(INTERVAL);
    await vi.advanceTimersByTimeAsync(0);
    runner.runAfterGameLogin();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.nativeScan).toHaveBeenCalledOnce();
  });

  it("leaves a direct runOnce ungated", async () => {
    await expect(runner.runOnce()).resolves.toBe(false);
    expect(h.nativeScan).toHaveBeenCalledOnce();
    expect(runner.getStatus().lastRunReason).toBe("game-not-running");
  });
});
