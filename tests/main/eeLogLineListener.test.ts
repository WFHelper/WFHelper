import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addLineListener,
  forceEeLogPoll,
  startWatching,
  stopWatching,
} from "../../services/eeLogMonitor";

const hoisted = vi.hoisted(() => ({
  logPath: "",
  emitDbwinLine: null as ((line: string) => void) | null,
}));

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

const ORIGINAL_PLATFORM = process.platform;
const EOM = "1281.547 Sys [Info]: EOM missionLocationUnlocked=1";

describe("EE.log line listeners", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-line-listener-"));
    hoisted.logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(hoisted.logPath, "");
    hoisted.emitDbwinLine = null;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.useFakeTimers();
    startWatching({});
  });

  afterEach(() => {
    stopWatching();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands every line to a listener with its source until unsubscribed", () => {
    const seen: Array<[string, string]> = [];
    const unsubscribe = addLineListener((line, source) => seen.push([line, source]));

    hoisted.emitDbwinLine?.(EOM);
    fs.appendFileSync(hoisted.logPath, `${EOM}\n`);
    forceEeLogPoll();
    unsubscribe();
    fs.appendFileSync(hoisted.logPath, `${EOM}\n`);
    forceEeLogPoll();

    expect(seen).toEqual([
      [EOM, "dbwin"],
      [EOM, "file"],
    ]);
  });

  it("keeps handling lines when a listener throws", () => {
    const seen: string[] = [];
    const unsubscribeThrowing = addLineListener(() => {
      throw new Error("listener failure");
    });
    const unsubscribe = addLineListener((line) => seen.push(line));

    expect(() => hoisted.emitDbwinLine?.(EOM)).not.toThrow();
    expect(seen).toEqual([EOM]);
    unsubscribeThrowing();
    unsubscribe();
  });
});
