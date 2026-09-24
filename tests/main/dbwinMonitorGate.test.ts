import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ constructed: [] as unknown[] }));

vi.mock("worker_threads", () => {
  class FakeWorker {
    constructor(...args: unknown[]) {
      hoisted.constructed.push(args);
    }
    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker, default: { Worker: FakeWorker } };
});

import { startDbwinWorker, stopDbwinWorker } from "../../services/dbwinMonitor";

describe("DBWIN reader gate", () => {
  afterEach(() => {
    stopDbwinWorker();
    vi.unstubAllEnvs();
    hoisted.constructed.length = 0;
  });

  it("starts no reader when WFHELPER_DISABLE_DBWIN=1", () => {
    vi.stubEnv("WFHELPER_DISABLE_DBWIN", "1");
    startDbwinWorker(() => undefined);
    expect(hoisted.constructed).toHaveLength(0);
  });

  it("starts the reader without the flag", () => {
    vi.stubEnv("WFHELPER_DISABLE_DBWIN", "");
    startDbwinWorker(() => undefined);
    expect(hoisted.constructed).toHaveLength(1);
  });
});
