import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPickerEntryMapping, startWatching, stopWatching } from "../../services/eeLogMonitor";

const hoisted = vi.hoisted(() => ({
  logPath: "",
  emitDbwinLine: null as ((line: string) => void) | null,
}));

// A real watcher would follow the fixture file; this test feeds lines itself.
vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => undefined, close: () => undefined }) },
}));

vi.mock("../../services/eeLogPath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/eeLogPath")>()),
  resolveEeLogPath: () => hoisted.logPath,
}));

vi.mock("../../services/dbwinMonitor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/dbwinMonitor")>()),
  isDbwinActive: () => true,
  startDbwinWorker: (onLine: (line: string) => void) => {
    hoisted.emitDbwinLine = onLine;
  },
  stopDbwinWorker: () => undefined,
}));

describe("relic picker close gate", () => {
  it("treats an InitMapping right after the open dispatch as picker entry", () => {
    expect(isPickerEntryMapping(1_500, 1_000)).toBe(true);
  });

  it("closes on a fast back-out beyond the entry window", () => {
    // 1.4s after the open is past the entry window, so this is a back-out, not entry.
    expect(isPickerEntryMapping(2_400, 1_000)).toBe(false);
  });

  it("counts a repeated InitMapping inside the window as entry too", () => {
    expect(isPickerEntryMapping(1_112, 1_000)).toBe(true);
    expect(isPickerEntryMapping(1_115, 1_000)).toBe(true);
  });
});

const ORIGINAL_PLATFORM = process.platform;
const OPEN_LINE = "128.401 Script [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd";
const INIT_MAPPING_LINE = "128.513 Sys [Info]: InitMapping for all devices with bindings";

describe("relic picker close dispatch", () => {
  let tmpDir = "";
  let opens = 0;
  let closes = 0;

  function emit(line: string): void {
    if (!hoisted.emitDbwinLine) throw new Error("dbwin worker was never started");
    hoisted.emitDbwinLine(line);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-relic-close-"));
    hoisted.logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(hoisted.logPath, "");
    hoisted.emitDbwinLine = null;
    opens = 0;
    closes = 0;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.useFakeTimers();
    startWatching({
      onRelicSelectionOpen: () => {
        opens += 1;
      },
      onRelicSelectionClose: () => {
        closes += 1;
      },
    });
    // Past the picker cooldown left by any earlier open in this file.
    vi.advanceTimersByTime(10_000);
  });

  afterEach(() => {
    stopWatching();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores every entry InitMapping and still closes on the real one", () => {
    emit(OPEN_LINE);
    vi.advanceTimersByTime(400); // past the open debounce
    expect(opens).toBe(1);

    // A second input device makes the game log InitMapping twice, 3ms apart.
    vi.advanceTimersByTime(112);
    emit(INIT_MAPPING_LINE);
    vi.advanceTimersByTime(3);
    emit(INIT_MAPPING_LINE);
    expect(closes).toBe(0);

    vi.advanceTimersByTime(2_000);
    emit(INIT_MAPPING_LINE);
    expect(closes).toBe(1);
  });
});
