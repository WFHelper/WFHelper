import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scripted: [] as Array<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
    /** Holds the response open, so a test can watch what runs meanwhile. */
    delayMs?: number;
  }>,
  requests: [] as Array<{ method: string; path: string; headers: Record<string, string> }>,
}));

vi.mock("node:https", () => {
  const request = (
    options: { method: string; path: string; headers: Record<string, string> },
    cb: (res: unknown) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.setHeader = () => {};
    req.write = () => {};
    req.destroy = (err: Error) => req.emit("error", err);
    req.end = () => {
      state.requests.push({
        method: options.method,
        path: options.path,
        headers: { ...options.headers },
      });
      const next = state.scripted.shift();
      if (!next) {
        queueMicrotask(() => req.emit("error", new Error("no scripted response left")));
        return;
      }
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
      res.statusCode = next.status;
      res.headers = next.headers ?? {};
      res.destroy = () => {};
      const answer = () => {
        cb(res);
        if (next.body) res.emit("data", Buffer.from(next.body, "utf-8"));
        res.emit("end");
      };
      if (next.delayMs) setTimeout(answer, next.delayMs);
      else queueMicrotask(answer);
    };
    return req;
  };
  return { default: { request }, request };
});

import {
  clearCsrfToken,
  request,
  requestRaw,
  requestV2,
  setTokenProvider,
  __test__,
} from "../../services/wfmClient";
import { getWfmSchedulerHealth, __schedulerTest__ } from "../../services/wfmScheduler";

const FAKE_JWT = `h.${Buffer.from(JSON.stringify({ csrf_token: "csrf" })).toString("base64url")}.s`;

describe("wfm client scheduling", () => {
  beforeEach(() => {
    state.scripted.length = 0;
    state.requests.length = 0;
    clearCsrfToken();
    setTokenProvider(() => null);
    __test__.resetHeaderAuthForTest();
    __test__.setClearanceForTest(null, null);
    __test__.resetClearanceCooldownForTest();
    __schedulerTest__.reset();
    // Real timers throughout, so keep every wait negligible.
    __schedulerTest__.configure({
      RETRY_BASE_MS: 5,
      RETRY_CEILING_MS: 10,
      MIN_RATE_LIMIT_GATE_MS: 5,
      BURST_TOKENS: 50,
      RATE_PER_SECOND: 10_000,
    });
  });

  afterEach(() => {
    setTokenProvider(() => null);
    __test__.setChallengeSolverForTest(null);
    __schedulerTest__.reset();
  });

  it("retries a GET through a 503 and returns the normal payload", async () => {
    state.scripted.push(
      { status: 503, body: "upstream down" },
      { status: 503, body: "upstream down" },
      { status: 200, body: '{"payload":{"items":[1]}}' },
    );

    await expect(request("GET", "/items")).resolves.toEqual({ payload: { items: [1] } });
    expect(state.requests).toHaveLength(3);
  });

  it("does not replay a mutation that got a 503", async () => {
    // Header auth keeps the CSRF page prefetch out of the scripted sequence.
    setTokenProvider(() => FAKE_JWT);
    state.scripted.push({ status: 503, body: '{"error":"boom"}' });

    await expect(requestV2("POST", "/order", { json: { itemId: "x" } })).rejects.toMatchObject({
      code: "WFM_API_ERROR",
      status: 503,
      message: "WFMClient v2 API error: boom",
    });
    expect(state.requests).toHaveLength(1);
  });

  it("does not retry a permanent answer", async () => {
    state.scripted.push({ status: 404, body: '{"error":"not found"}' });

    await expect(request("GET", "/items/nope")).rejects.toMatchObject({
      code: "WFM_API_ERROR",
      status: 404,
      message: "WFMClient API error: not found",
    });
    expect(state.requests).toHaveLength(1);
  });

  it("retries a 429 that carried a short Retry-After", async () => {
    state.scripted.push(
      { status: 429, headers: { "retry-after": "0" }, body: "slow down" },
      { status: 200, body: '{"ok":true}' },
    );

    await expect(request("GET", "/items")).resolves.toEqual({ ok: true });
    expect(state.requests).toHaveLength(2);
  });

  it("keeps the unchanged rate-limit error when the cooldown outlasts the retry budget", async () => {
    __schedulerTest__.configure({ MIN_RATE_LIMIT_GATE_MS: 1_000 });
    state.scripted.push({ status: 429, body: "slow down" });

    await expect(request("GET", "/items")).rejects.toMatchObject({
      name: "WfmApiError",
      code: "WFM_RATE_LIMITED",
      status: 429,
      message: "Warframe.market rate limit hit. Please wait 30s before trying again.",
    });
    expect(state.requests).toHaveLength(1);

    const health = getWfmSchedulerHealth();
    expect(health.state).toBe("backoff");
    expect(health.backoffUntil).toBeGreaterThan(Date.now());
  });

  it("honours a server-stated Retry-After instead of the old 30s floor", async () => {
    state.scripted.push({ status: 429, headers: { "retry-after": "15" }, body: "slow down" });

    await expect(request("GET", "/items")).rejects.toMatchObject({
      code: "WFM_RATE_LIMITED",
      message: "Warframe.market rate limit hit. Please wait 15s before trying again.",
    });
    expect(state.requests).toHaveLength(1);
  });

  it("never resends a rate-limited sign-in even when the wait is trivial", async () => {
    state.scripted.push(
      { status: 429, headers: { "retry-after": "0" }, body: "slow down" },
      { status: 200, body: '{"ok":true}' },
    );

    await expect(
      requestRaw("POST", "/auth/signin", {
        json: { email: "a@b.c", password: "secret" },
        headerAuth: true,
      }),
    ).rejects.toMatchObject({ code: "WFM_RATE_LIMITED", status: 429 });
    expect(state.requests).toHaveLength(1);
  });

  it("passes a 401 through unchanged without retrying", async () => {
    state.scripted.push({ status: 401, body: '{"error":"unauthorized"}' });

    await expect(requestV2("GET", "/me")).rejects.toMatchObject({
      name: "WfmApiError",
      code: "WFM_UNAUTHORIZED",
      status: 401,
      message: "Warframe.market session expired or invalid.",
    });
    expect(state.requests).toHaveLength(1);
    expect(getWfmSchedulerHealth()).toEqual({ state: "ok", recentFailures: 0 });
  });

  it("retries a dropped socket on a GET and reports the same network error when it persists", async () => {
    __schedulerTest__.configure({ MAX_RETRIES: 2 });

    await expect(request("GET", "/items")).rejects.toMatchObject({
      name: "WfmApiError",
      code: "WFM_NETWORK_ERROR",
      message: "WFMClient network error: no scripted response left",
    });
    expect(state.requests).toHaveLength(3);
  });

  it("surfaces a non-JSON body as WFM_INVALID_JSON without a replay", async () => {
    state.scripted.push({ status: 200, body: "<html>nope</html>" });

    await expect(request("GET", "/items")).rejects.toMatchObject({
      code: "WFM_INVALID_JSON",
      status: 200,
    });
    expect(state.requests).toHaveLength(1);
  });

  it("gives the slot back while the CSRF page prefetch runs", async () => {
    __schedulerTest__.configure({ MAX_CONCURRENT: 1 });
    state.scripted.push(
      // The warframe.market page the prefetch loads, held open.
      {
        status: 200,
        headers: { "set-cookie": `JWT=${FAKE_JWT}; Path=/` },
        body: "<html></html>",
        delayMs: 30,
      },
      { status: 200, body: '{"ok":true}' },
      { status: 200, body: '{"created":true}' },
    );

    const mutation = requestV2("POST", "/order", { json: { itemId: "x" } });
    const read = request("GET", "/items");

    await expect(read).resolves.toEqual({ ok: true });
    await expect(mutation).resolves.toEqual({ created: true });
    // The read went out while the prefetch was still open, not after the POST.
    expect(state.requests.map((entry) => entry.path)).toEqual(["/", "/v1/items", "/v2/order"]);
  });

  it("gives the slot back while a Cloudflare challenge window is open", async () => {
    __schedulerTest__.configure({ MAX_CONCURRENT: 1 });
    let releaseChallenge: (solved: boolean) => void = () => {};
    let challengeEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      challengeEntered = resolve;
    });
    __test__.setChallengeSolverForTest(() => {
      challengeEntered();
      return new Promise<boolean>((resolve) => {
        releaseChallenge = resolve;
      });
    });
    state.scripted.push(
      { status: 403, headers: { "cf-mitigated": "challenge" }, body: "just a moment" },
      { status: 200, body: '{"second":true}' },
      { status: 200, body: '{"first":true}' },
    );

    const challenged = request("GET", "/items");
    await entered;

    // A window that waits on the user must not hold the only request slot.
    await expect(request("GET", "/other")).resolves.toEqual({ second: true });
    releaseChallenge(true);
    await expect(challenged).resolves.toEqual({ first: true });
  });
});
