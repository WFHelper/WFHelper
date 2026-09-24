import Module from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
const realPlatform = process.platform;
const STATUS_ACCESS_DENIED = -0x3fffffde;
const STATUS_PROCESS_IS_TERMINATING = -0x3ffffef6;
const COMMAND_LINE = '"C:\\Warframe\\Warframe.x64.exe" -applet:/EE/Types';
const openProcess = vi.fn();
const closeHandle = vi.fn(() => 1);
let queryResult = 0;

beforeEach(() => {
  vi.resetModules();
  openProcess.mockReset().mockReturnValue({});
  closeHandle.mockClear();
  queryResult = 0;
  const native: Record<string, unknown> = {
    OpenProcess: openProcess,
    CloseHandle: closeHandle,
    NtQueryInformationProcess: (_handle: unknown, _kind: number, out: Buffer) => {
      if (queryResult < 0) return queryResult;
      const text = Buffer.from(COMMAND_LINE, "utf16le");
      out.writeUInt16LE(text.length, 0);
      text.copy(out, 16);
      return 0;
    },
  };
  const fakeKoffi = {
    load: () => ({ func: (name: string) => native[name] ?? (() => 0) }),
    struct: () => ({}),
    array: () => ({}),
    sizeof: (type: unknown) => (type === "void *" ? 8 : 568),
    offsetof: () => 0,
  };
  vi.spyOn(loader, "_load").mockImplementation((id, ...args) =>
    id === "koffi" ? fakeKoffi : originalLoad.call(Module, id, ...args),
  );
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("queryCommandLine", () => {
  it("opens with limited query access and decodes the text after the header", async () => {
    const { queryCommandLine } = await import("../../services/win32Process");
    expect(queryCommandLine(42)).toEqual({ status: "ok", commandLine: COMMAND_LINE });
    expect(openProcess).toHaveBeenCalledExactlyOnceWith(0x1000, 0, 42);
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it.each([
    [STATUS_PROCESS_IS_TERMINATING, "exiting"],
    [STATUS_ACCESS_DENIED, "unreadable"],
  ])("maps NTSTATUS %s to %s and closes the handle", async (status, expected) => {
    queryResult = status;
    const { queryCommandLine } = await import("../../services/win32Process");
    expect(queryCommandLine(42)).toEqual({ status: expected });
    expect(closeHandle).toHaveBeenCalledOnce();
  });

  it("reports a process that cannot be opened as unreadable", async () => {
    openProcess.mockReturnValue(null);
    const { queryCommandLine } = await import("../../services/win32Process");
    expect(queryCommandLine(42)).toEqual({ status: "unreadable" });
    expect(closeHandle).not.toHaveBeenCalled();
  });
});
