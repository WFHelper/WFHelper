import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ processes: [] as { pid: number; name: string }[] }));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../../services/win32Process", async (original) => ({
  ...(await original<typeof import("../../services/win32Process")>()),
  enumProcessNames: () => probe.processes,
  getProcessSessionId: () => 1,
}));

const windowsTest = process.platform === "win32" ? it : it.skip;
const children: ChildProcess[] = [];

async function idleChild(...args: string[]): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  await once(child, "spawn");
  return child.pid!;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe("Warframe process command line", () => {
  windowsTest("tells the launcher's content-update applet from the game", async () => {
    const applet = await idleChild(
      "-silent",
      "-log:/Preprocess.log",
      "-applet:/EE/Types/Framework/ContentUpdate",
    );
    const game = await idleChild("-windowMode:2", "-cluster:public", "-clienttype:Steam");
    const status = await import("../../services/warframeStatus");

    probe.processes = [{ pid: applet, name: "Warframe.x64.exe" }];
    expect(status.getWarframeProcessState(true)).toBe(false);
    probe.processes = [
      { pid: applet, name: "Warframe.x64.exe" },
      { pid: game, name: "Warframe.x64.exe" },
    ];
    expect(status.getWarframeProcessState(true)).toBe(true);
  });
});
