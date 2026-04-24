import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pinnedHash = "3f883abb1226c9da6d6cb9c2d6675d3daa6b321a192583c646ef8c45cbd5b8f6";
  const hash = {
    update: vi.fn(),
    digest: vi.fn(),
  };
  hash.update.mockReturnValue(hash);
  hash.digest.mockReturnValue(pinnedHash);

  return {
    appGetPath: vi.fn((name: string) => `D:/mock/${name}`),
    existsSync: vi.fn((filePath: string) => filePath.endsWith("warframe-api-helper.exe")),
    readFileSync: vi.fn(() => Buffer.from("helper")),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    createHash: vi.fn(() => hash),
    spawn: vi.fn(() => ({
      on: vi.fn(),
      kill: vi.fn(),
    })),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: mocks.appGetPath,
  },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    statSync: mocks.statSync,
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    createWriteStream: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  default: {
    createHash: mocks.createHash,
  },
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
  vi.resetModules();
  mocks.spawn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("apiHelperRunner polling", () => {
  it("cancels the deferred startup poll when polling stops", async () => {
    const { startPolling, stopPolling } = await import("../../services/apiHelperRunner");

    startPolling(10 * 60 * 1000);
    stopPolling();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
