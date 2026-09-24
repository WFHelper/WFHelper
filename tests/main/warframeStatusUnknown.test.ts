import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  processes: [{ pid: 2, name: "Warframe.x64.exe" }] as { pid: number; name: string }[] | null,
  sessionOf: ((pid: number) => (pid === 1 ? 1 : 1)) as (pid: number) => number | null,
}));

vi.mock("../../services/win32Process", () => ({
  enumProcessNames: vi.fn(() => probe.processes),
  getProcessSessionId: vi.fn((pid: number) => probe.sessionOf(pid)),
  isWarframeExePath: vi.fn(() => false),
  queryExePath: vi.fn(() => null),
  queryCommandLine: vi.fn(() => ({
    status: "ok",
    commandLine: "Warframe.x64.exe -cluster:public",
  })),
}));

vi.mock("../../services/x11WindowQuery", () => ({
  findWindowBoundsByTitle: vi.fn(() => null),
  isWindowFocusedByTitle: vi.fn(() => false),
}));

vi.mock("electron", () => ({
  screen: { getDisplayMatching: vi.fn(() => ({ id: 7 })) },
  app: { once: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

const realPlatform = process.platform;

async function loadStatus() {
  vi.resetModules();
  return await import("../../services/warframeStatus");
}

describe("warframe status keeps an unknown process sample from reading as an exit", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    probe.processes = [{ pid: 2, name: "Warframe.x64.exe" }];
    probe.sessionOf = () => 1;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.useRealTimers();
  });

  it("holds the running state when process enumeration stops answering", async () => {
    const status = await loadStatus();

    const running = await status.getStatus({ force: true });
    expect(running.isOpen).toBe(true);
    expect(running.processRunning).toBe(true);

    probe.processes = null;
    const unknown = await status.getStatus({ force: true });
    expect(unknown.isOpen).toBe(true);
    expect(unknown.processRunning).toBe(true);
  });

  it("holds the running state when the game pid cannot be opened", async () => {
    const status = await loadStatus();

    expect((await status.getStatus({ force: true })).isOpen).toBe(true);

    probe.sessionOf = (pid: number) => (pid === process.pid ? 1 : null);
    const unknown = await status.getStatus({ force: true });
    expect(unknown.isOpen).toBe(true);
  });

  it("still reports an exit once a sample actually answers false", async () => {
    const status = await loadStatus();

    expect((await status.getStatus({ force: true })).isOpen).toBe(true);

    probe.processes = [{ pid: 2, name: "explorer.exe" }];
    const closed = await status.getStatus({ force: true });
    expect(closed.isOpen).toBe(false);
    expect(closed.processRunning).toBe(false);
  });

  it("reports not running when the first sample is already unknown", async () => {
    probe.processes = null;
    const status = await loadStatus();

    expect((await status.getStatus({ force: true })).isOpen).toBe(false);
    expect(status.isWarframeRunningCached()).toBeNull();
  });

  it("stops reporting a held state as known once no sample answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const status = await loadStatus();

    probe.processes = [{ pid: 2, name: "explorer.exe" }];
    await status.getStatus({ force: true });
    expect(status.isWarframeRunningCached()).toBe(false);

    probe.processes = null;
    for (let poll = 0; poll < 12; poll++) {
      vi.setSystemTime(Date.now() + 3_000);
      expect((await status.getStatus({ force: true })).processRunning).toBe(false);
    }
    expect(status.isWarframeRunningCached()).toBeNull();
  });
});
