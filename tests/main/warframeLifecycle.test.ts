import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  write: vi.fn(),
  login: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  schtasksFails: false,
  deleteFails: false,
  taskMissing: false,
  warn: vi.fn(),
  unref: vi.fn(),
  pids: vi.fn(),
  session: vi.fn((_pid: number): number | null => 1),
  exe: vi.fn(),
  packaged: false,
  spawnError: false,
  failWrite: false,
}));

vi.mock("node:child_process", () => ({ spawn: h.spawn, execFile: h.execFile }));
vi.mock("node:fs", () => ({
  default: {
    existsSync: (file: string) => h.files.has(file),
    readFileSync: (file: string) => {
      if (file.endsWith(".ps1")) return "watcher-script";
      if (!h.files.has(file)) throw new Error("missing file");
      return h.files.get(file);
    },
    rmSync: (file: string) => h.files.delete(file),
  },
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.packaged;
    },
    getAppPath: () => "C:\\WF Helper",
    setLoginItemSettings: h.login,
  },
}));
vi.mock("../../services/atomicFile", () => ({ writeFileAtomicSync: h.write }));
vi.mock("../../services/userDataPath", () => ({
  userDataPath: (name: string) => path.join("C:\\App Data\\WFHelper", name),
}));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: h.warn }),
}));
vi.mock("../../services/win32Process", () => ({
  enumProcessNames: h.pids,
  getProcessSessionId: h.session,
  queryExePath: h.exe,
  isWarframeExePath: (file: string) => file.toLowerCase().endsWith("\\warframe.x64.exe"),
}));

type Lifecycle = typeof import("../../services/warframeLifecycle");
let lifecycle: Lifecycle;
const configPath = path.join("C:\\App Data\\WFHelper", "warframe-watcher.json");
const taskPath = path.join("C:\\App Data\\WFHelper", "warframe-watcher-task.xml");
const LEGACY_TASK = "WFHelperWarframeWatcher";
const USER_TASK = "WFHelper\\WarframeWatcher-Tester";
const quit = vi.fn();

function schtasksCalls(): string[] {
  return h.execFile.mock.calls.map((call) => (call[1] as string[]).join(" "));
}

function escapeForXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
const realPlatform = process.platform;

function gameRunning(running: boolean): void {
  h.session.mockReturnValue(1);
  h.pids.mockReturnValue([
    { pid: running ? 10 : 20, name: running ? "Warframe.x64.exe" : "explorer.exe" },
  ]);
  h.exe.mockReturnValue({
    status: "ok",
    path: running ? "C:\\Warframe\\Warframe.x64.exe" : "C:\\Windows\\explorer.exe",
  });
}

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  vi.stubEnv("WFHELPER_USER_DATA", "");
  vi.stubEnv("USERNAME", "Tester");
  h.files.clear();
  h.packaged = false;
  h.spawnError = false;
  h.failWrite = false;
  h.schtasksFails = false;
  h.deleteFails = false;
  h.taskMissing = false;
  h.execFile.mockImplementation(
    (
      _exe: string,
      args: string[],
      _options: unknown,
      done: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      let stderr = "";
      if (h.schtasksFails && args.includes("/Create")) stderr = "ERROR: Access is denied.";
      else if (h.taskMissing && args.includes("/Query")) {
        stderr = "FEHLER: Das System kann die Datei nicht finden.";
      } else if (h.deleteFails && args.includes("/Delete")) stderr = "ERROR: Access is denied.";
      void Promise.resolve().then(() =>
        done(stderr ? new Error("schtasks exited with 1") : null, "", stderr),
      );
    },
  );
  h.write.mockImplementation((file: string, text: string) => {
    if (h.failWrite) {
      h.failWrite = false;
      throw new Error("disk full");
    }
    h.files.set(file, text);
  });
  h.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: h.unref });
    void Promise.resolve().then(() => {
      if (h.spawnError) child.emit("error", new Error("spawn denied"));
      else child.emit("spawn");
    });
    return child;
  });
  gameRunning(false);
  lifecycle = await import("../../services/warframeLifecycle");
});

afterEach(() => {
  lifecycle.stopWarframeLifecycle();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("Warframe lifecycle", () => {
  it("leaves startup registration and the watcher untouched by default", async () => {
    h.taskMissing = true;
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(schtasksCalls()).toEqual([`/Query /TN ${USER_TASK}`]);
    expect(h.login).not.toHaveBeenCalled();
    expect(h.pids).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it("removes a sign-in task stranded without its watcher files", async () => {
    await lifecycle.configureWarframeLifecycle(false);
    expect(schtasksCalls()).toEqual([`/Query /TN ${USER_TASK}`, `/Delete /TN ${USER_TASK} /F`]);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("never probes for a sandbox sign-in task", async () => {
    vi.stubEnv("WFHELPER_USER_DATA", "C:\\sandbox");
    await lifecycle.configureWarframeLifecycle(false);
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("keeps startup going when the task probe cannot run", async () => {
    h.execFile.mockImplementation(() => {
      throw new Error("schtasks is not installed");
    });
    await expect(lifecycle.configureWarframeLifecycle(false)).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not check the sign-in task"),
      expect.stringContaining("schtasks is not installed"),
    );
  });

  it("enables an app-owned hidden watcher and registers sign-in startup", async () => {
    await lifecycle.configureWarframeLifecycle(true);
    expect(JSON.parse(h.files.get(configPath)!)).toMatchObject({
      enabled: true,
      revision: expect.any(String),
      executable: process.execPath,
      arguments: ['"C:\\WF Helper"', "--warframe-auto-launch"],
      appPid: process.pid,
      exitGraceMs: 10_000,
    });
    // A detached powershell.exe exits at once without running the watcher.
    expect(h.spawn).toHaveBeenCalledWith(
      expect.stringContaining("conhost.exe"),
      expect.arrayContaining(["--headless", "-WindowStyle", "Hidden", "-ConfigPath", configPath]),
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    expect(h.spawn.mock.calls[0]?.[1]?.[1]).toContain("powershell.exe");
    expect(h.login).toHaveBeenCalledWith({
      name: LEGACY_TASK,
      openAtLogin: false,
    });
    expect(h.execFile).toHaveBeenCalledWith(
      expect.stringContaining("schtasks.exe"),
      ["/Create", "/TN", USER_TASK, "/XML", taskPath, "/F"],
      { windowsHide: true, encoding: "utf8" },
      expect.any(Function),
    );
    const xml = Buffer.from(h.files.get(taskPath)! as unknown as Uint8Array).toString("utf16le");
    expect(xml).toContain('encoding="UTF-16"');
    expect(xml).toContain("<UserId>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toMatch(/<Command>[^<]*conhost\.exe<\/Command>/);
    expect(xml).toContain("--headless");
    expect(xml).toContain(escapeForXml(configPath));
    expect(h.unref).toHaveBeenCalledOnce();
    await lifecycle.configureWarframeLifecycle(true);
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it("never registers a sandbox launch at Windows sign-in", async () => {
    vi.stubEnv("WFHELPER_USER_DATA", "C:\\sandbox");
    await lifecycle.configureWarframeLifecycle(true);
    expect(h.login).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.files.has(taskPath)).toBe(false);
  });

  it("registers a per-user task and clears the machine-wide legacy one", async () => {
    await lifecycle.configureWarframeLifecycle(true);
    const enabling = schtasksCalls();
    expect(enabling).toContain(`/Query /TN ${LEGACY_TASK}`);
    expect(enabling).toContain(`/Delete /TN ${LEGACY_TASK} /F`);
    expect(enabling.some((args) => args.startsWith(`/Create /TN ${USER_TASK} `))).toBe(true);
    await lifecycle.configureWarframeLifecycle(false);
    const disabling = schtasksCalls();
    expect(disabling).toContain(`/Delete /TN ${USER_TASK} /F`);
    expect(disabling.filter((args) => args === `/Delete /TN ${LEGACY_TASK} /F`)).toHaveLength(2);
  });

  it("warns when Windows refuses to remove a sign-in task", async () => {
    await lifecycle.configureWarframeLifecycle(true);
    h.deleteFails = true;
    await lifecycle.configureWarframeLifecycle(false);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining(USER_TASK),
      expect.stringContaining("Access is denied"),
    );
  });

  it("stays silent when there is no sign-in task to remove", async () => {
    h.files.set(path.join("C:\\App Data\\WFHelper", "warframe-watcher.ps1"), "old script");
    h.taskMissing = true;
    await lifecycle.configureWarframeLifecycle(false);
    expect(schtasksCalls().map((args) => args.split(" ")[0])).toEqual(["/Query", "/Query"]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("shares the process snapshot with status callers without opening processes", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    const status = await import("../../services/warframeStatus");
    expect(status.getWarframeProcessState()).toBe(true);
    expect(h.pids).toHaveBeenCalledTimes(1);
    expect(h.exe).not.toHaveBeenCalled();
    // Two 2 s ticks and a 3 s hotkey-gate read all fall inside one sample.
    await vi.advanceTimersByTimeAsync(3000);
    expect(status.getWarframeProcessState()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.pids).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.getWarframeProcessState()).toBe(true);
    expect(h.pids).toHaveBeenCalledTimes(2);
    expect(h.exe).not.toHaveBeenCalled();
  });

  it("refreshes the process sample when status is forced inside the cache TTL", async () => {
    const status = await import("../../services/warframeStatus");
    expect((await status.getStatus()).processRunning).toBe(false);
    gameRunning(true);
    expect((await status.getStatus()).processRunning).toBe(false);
    expect(h.pids).toHaveBeenCalledTimes(1);
    expect((await status.getStatus({ force: true })).processRunning).toBe(true);
    expect(h.pids).toHaveBeenCalledTimes(2);
    expect(status.getWarframeProcessState()).toBe(true);
    expect(h.pids).toHaveBeenCalledTimes(2);
    gameRunning(false);
    expect((await status.getStatus({ force: true })).processRunning).toBe(false);
    expect(h.pids).toHaveBeenCalledTimes(3);
  });

  it.each(["WarframeLauncher.exe", "WarframeHelper.exe", "Warframe.x64.exe.backup"])(
    "does not match %s as the game process",
    async (name) => {
      h.pids.mockReturnValue([{ pid: 10, name }]);
      const status = await import("../../services/warframeStatus");
      expect(status.getWarframeProcessState()).toBe(false);
    },
  );

  it("reports a failed process enumeration as unknown", async () => {
    h.pids.mockImplementationOnce(() => {
      throw new Error("enumeration unavailable");
    });
    const status = await import("../../services/warframeStatus");
    expect(status.getWarframeProcessState()).toBeNull();
  });

  it("keeps a manually launched app open when no game was observed", async () => {
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(quit).not.toHaveBeenCalled();
  });

  it("quits once after an observed game stays absent for ten seconds", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    gameRunning(false);
    // The sample taken at 0 s is served until 5 s, so the 6 s tick sees the exit.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(quit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(quit).toHaveBeenCalledOnce();
  });

  it.each(["present", "unavailable"])("resets the exit grace after a %s scan", async (scan) => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(6000);
    if (scan === "present") gameRunning(true);
    else h.pids.mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(6000);
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(quit).toHaveBeenCalledOnce();
  });

  it("disables watcher startup and prevents an outstanding exit grace from quitting", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(8000);
    await lifecycle.configureWarframeLifecycle(false);
    expect(h.files.has(configPath)).toBe(false);
    expect(h.files.has(path.join("C:\\App Data\\WFHelper", "warframe-watcher.ps1"))).toBe(false);
    expect(h.login).toHaveBeenLastCalledWith(expect.objectContaining({ openAtLogin: false }));
    expect(h.execFile).toHaveBeenLastCalledWith(
      expect.stringContaining("schtasks.exe"),
      ["/Delete", "/TN", USER_TASK, "/F"],
      expect.anything(),
      expect.any(Function),
    );
    expect(h.files.has(taskPath)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it("can disable after its configuration file was removed", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    h.files.delete(configPath);
    await lifecycle.configureWarframeLifecycle(false);
    expect(h.login).toHaveBeenLastCalledWith(expect.objectContaining({ openAtLogin: false }));
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).not.toHaveBeenCalled();
  });

  it("does not require opening the game process to identify it", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    h.exe.mockReturnValue({ status: "unknown" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).not.toHaveBeenCalled();
    expect(h.exe).not.toHaveBeenCalled();
  });

  it("does not let unrelated protected processes block a confirmed game exit", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    h.pids.mockReturnValue([
      { pid: 4, name: "System" },
      { pid: 11, name: "protected.exe" },
    ]);
    h.session.mockImplementation((pid: number) => (pid === process.pid ? 1 : null));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).toHaveBeenCalledOnce();
    expect(h.session).not.toHaveBeenCalledWith(4);
    expect(h.session).not.toHaveBeenCalledWith(11);
  });

  it("keeps an exact game candidate with an unreadable session unknown", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    h.session.mockImplementation((pid: number) => (pid === process.pid ? 1 : null));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).not.toHaveBeenCalled();
  });

  it("keeps the watcher revision across ordinary app restarts", async () => {
    await lifecycle.configureWarframeLifecycle(true);
    const first = JSON.parse(h.files.get(configPath)!) as { revision: string };
    vi.resetModules();
    lifecycle = await import("../../services/warframeLifecycle");
    await lifecycle.configureWarframeLifecycle(true);
    expect(JSON.parse(h.files.get(configPath)!)).toMatchObject({
      revision: first.revision,
      appPid: process.pid,
    });
  });

  it("repairs an outdated executable path before launching the watcher", async () => {
    h.files.set(
      configPath,
      JSON.stringify({
        enabled: true,
        executable: "C:\\old\\wfhelper.exe",
        revision: "old",
        appPid: 999,
      }),
    );
    await lifecycle.configureWarframeLifecycle(true);
    expect(JSON.parse(h.files.get(configPath)!)).toMatchObject({
      executable: process.execPath,
      appPid: process.pid,
    });
    expect(h.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["-ExpectedExecutable", process.execPath]),
    );
  });

  it("removes an orphaned watcher script while disabled", async () => {
    const script = path.join("C:\\App Data\\WFHelper", "warframe-watcher.ps1");
    h.files.set(script, "old script");
    await lifecycle.configureWarframeLifecycle(false);
    expect(h.files.has(script)).toBe(false);
    expect(h.files.has(configPath)).toBe(false);
    expect(h.login).toHaveBeenLastCalledWith(expect.objectContaining({ openAtLogin: false }));
  });

  it.each([
    ["write", "disk full"],
    ["spawn", "spawn denied"],
    ["schtasks", "Access is denied"],
  ])("rolls back a %s failure and permits retry", async (failure, message) => {
    h.files.set(configPath, '{"enabled":false,"revision":"old"}');
    if (failure === "write") h.failWrite = true;
    else if (failure === "spawn") h.spawnError = true;
    else h.schtasksFails = true;
    await expect(lifecycle.configureWarframeLifecycle(true)).rejects.toThrow(message);
    expect(h.files.get(configPath)).toBe('{"enabled":false,"revision":"old"}');
    expect(h.login).toHaveBeenLastCalledWith(expect.objectContaining({ openAtLogin: false }));
    h.spawnError = false;
    h.schtasksFails = false;
    await lifecycle.configureWarframeLifecycle(true);
    expect(JSON.parse(h.files.get(configPath)!)).toMatchObject({ enabled: true });
  });

  it("reports the original failure when re-registering the task also fails", async () => {
    await lifecycle.configureWarframeLifecycle(true);
    h.failWrite = true;
    h.schtasksFails = true;

    await expect(lifecycle.configureWarframeLifecycle(false)).rejects.toThrow("disk full");
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not restore the sign-in task"),
      expect.stringContaining("Access is denied"),
    );
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not configure automatic launch"),
      expect.stringContaining("disk full"),
    );
  });

  it("ignores games running in another Windows session", async () => {
    gameRunning(true);
    h.session.mockImplementation((pid: number) => (pid === process.pid ? 1 : 2));
    lifecycle.startWarframeLifecycle(quit);
    await lifecycle.configureWarframeLifecycle(true);
    await vi.advanceTimersByTimeAsync(4000);
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit).not.toHaveBeenCalled();
  });

  it("stops polling and releases the quit callback", async () => {
    gameRunning(true);
    lifecycle.startWarframeLifecycle(quit);
    lifecycle.startWarframeLifecycle(quit);
    expect(vi.getTimerCount()).toBe(1);
    await lifecycle.configureWarframeLifecycle(true);
    lifecycle.stopWarframeLifecycle();
    expect(vi.getTimerCount()).toBe(0);
    const samples = h.pids.mock.calls.length;
    gameRunning(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.pids).toHaveBeenCalledTimes(samples);
    expect(quit).not.toHaveBeenCalled();
  });
});
