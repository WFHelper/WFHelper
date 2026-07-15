import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

type OcrServerModule = typeof import("../../services/ocrServer");

interface FakeProc extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => void };
  killed: boolean;
  kill: () => void;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  const stdout = new EventEmitter() as FakeProc["stdout"];
  stdout.setEncoding = () => {};
  proc.stdout = stdout;
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {} };
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

const STARTUP_UNAVAILABLE =
  '{"id":"startup","ok":false,"error":"Windows OCR engine unavailable on this system"}';

// ps1 behavior on a machine without an OCR language pack: startup JSON, exit 1
function failStartup(): void {
  spawnMock.mockImplementation(() => {
    const proc = makeFakeProc();
    queueMicrotask(() => {
      proc.stdout.emit("data", `${STARTUP_UNAVAILABLE}\n`);
      proc.emit("close", 1);
    });
    return proc;
  });
}

async function freshModule(): Promise<OcrServerModule> {
  vi.resetModules();
  return import("../../services/ocrServer");
}

describe("ocrServer engine-unavailable latch", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces the ps1 startup error, latches, and fails fast without respawning", async () => {
    const mod = await freshModule();
    failStartup();

    await expect(mod.ocrServer.runOCRStructured({ imageBase64: "eA==" }, 2000)).rejects.toThrow(
      /Windows OCR engine unavailable on this system/,
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(mod.getWindowsOcrHealth()).toEqual({
      available: false,
      reason: "Windows OCR engine unavailable on this system",
    });

    await expect(mod.ocrServer.runOCRStructured({ imageBase64: "eA==" }, 2000)).rejects.toThrow(
      /Windows OCR unavailable/,
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh probe after the retry window", async () => {
    const mod = await freshModule();
    failStartup();

    await expect(mod.ocrServer.runOCRStructured({ imageBase64: "eA==" }, 2000)).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60_000 + 1_000);

    await expect(mod.ocrServer.runOCRStructured({ imageBase64: "eA==" }, 2000)).rejects.toThrow(
      /exited before ready/,
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("serves structured results and stays healthy when the server starts", async () => {
    const mod = await freshModule();
    spawnMock.mockImplementation(() => {
      const proc = makeFakeProc();
      proc.stdin = {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as { id: string };
          queueMicrotask(() => {
            proc.stdout.emit(
              "data",
              `${JSON.stringify({ id: request.id, ok: true, result: { text: "hello", lines: [] } })}\n`,
            );
          });
        },
      };
      queueMicrotask(() => proc.stdout.emit("data", "===OCR_SERVER_READY===\n"));
      return proc;
    });

    const result = await mod.ocrServer.runOCRStructured({ imageBase64: "eA==" }, 2000);
    expect(result.text).toBe("hello");
    expect(mod.getWindowsOcrHealth()).toEqual({ available: true, reason: null });
  });
});
