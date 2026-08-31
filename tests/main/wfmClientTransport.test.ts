import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scripted: [] as Array<{ status: number; headers?: Record<string, string>; body?: string }>,
  requests: [] as Array<Record<string, string>>,
}));

vi.mock("node:https", () => {
  const request = (options: { headers: Record<string, string> }, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setHeader = () => {};
    req.write = () => {};
    req.destroy = (err: Error) => req.emit("error", err);
    req.end = () => {
      state.requests.push({ ...options.headers });
      const next = state.scripted.shift();
      if (!next) {
        queueMicrotask(() => req.emit("error", new Error("no scripted response left")));
        return;
      }
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
      res.statusCode = next.status;
      res.headers = next.headers ?? {};
      res.destroy = () => {};
      queueMicrotask(() => {
        cb(res);
        if (next.body) res.emit("data", Buffer.from(next.body, "utf-8"));
        res.emit("end");
      });
    };
    return req;
  };
  return { default: { request }, request };
});

import { request, __test__ } from "../../services/wfmClient";
import { __schedulerTest__ } from "../../services/wfmScheduler";

function fakeChromiumNet(errorMessage: string) {
  const requestFn = vi.fn(() => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setHeader = () => {};
    req.write = () => {};
    req.abort = () => {};
    req.end = () => {
      queueMicrotask(() => req.emit("error", new Error(errorMessage)));
    };
    return req;
  });
  return { net: { request: requestFn } as never, requestFn };
}

describe("chromium transport fallback", () => {
  beforeEach(() => {
    state.scripted.length = 0;
    state.requests.length = 0;
    __test__.setClearanceForTest(null, null);
    // Transport selection only - scheduler retries are covered separately and
    // would otherwise multiply the send counts asserted below.
    __schedulerTest__.reset();
    __schedulerTest__.configure({ MAX_RETRIES: 0 });
  });

  afterEach(() => {
    __test__.setChromiumNetForTest(undefined);
    __schedulerTest__.reset();
  });

  it("retries via node https on a net::ERR_* failure and latches node", async () => {
    const { net, requestFn } = fakeChromiumNet("net::ERR_FAILED");
    __test__.setChromiumNetForTest(net);
    state.scripted.push({ status: 200, body: '{"ok":true}' }, { status: 200, body: '{"ok":2}' });

    await expect(request("GET", "/items")).resolves.toEqual({ ok: true });
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(state.requests).toHaveLength(1);

    // Latched: the second call never touches the chromium stack again.
    await expect(request("GET", "/items")).resolves.toEqual({ ok: 2 });
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(state.requests).toHaveLength(2);
  });

  it("does not fall back on non-chromium errors", async () => {
    const { net, requestFn } = fakeChromiumNet("socket hang up");
    __test__.setChromiumNetForTest(net);

    await expect(request("GET", "/items")).rejects.toMatchObject({ code: "WFM_NETWORK_ERROR" });
    expect(state.requests).toHaveLength(0);

    // No latch either: the next call still tries chromium first.
    await expect(request("GET", "/items")).rejects.toMatchObject({ code: "WFM_NETWORK_ERROR" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });
});
