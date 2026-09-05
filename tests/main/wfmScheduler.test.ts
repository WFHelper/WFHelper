import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getWfmSchedulerHealth,
  scheduleWfmRequest,
  WFM_SCHEDULER_DEFAULTS,
  __schedulerTest__,
  type WfmAttemptOutcome,
  type WfmSchedulerHealth,
} from "../../services/wfmScheduler";
import { WfmApiError } from "../../services/wfmTypes";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain queued microtasks without moving the fake clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function ok<T>(value: T): WfmAttemptOutcome<T> {
  return { kind: "ok", value };
}

function transientFailure<T>(
  error: Error,
  extra: { status?: number; retryAfterMs?: number } = {},
): WfmAttemptOutcome<T> {
  return { kind: "failure", error, retryable: true, transient: true, ...extra };
}

describe("wfm scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __schedulerTest__.reset();
  });

  afterEach(() => {
    __schedulerTest__.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("request budget", () => {
    it("spends the burst immediately then paces at the sustained rate", async () => {
      __schedulerTest__.configure({
        BURST_TOKENS: 3,
        RATE_PER_SECOND: 2,
        MAX_CONCURRENT: 10,
      });
      const start = Date.now();
      const startedAt: number[] = [];

      const all = Array.from({ length: 6 }, (_, i) =>
        scheduleWfmRequest(async () => {
          startedAt.push(Date.now() - start);
          return ok(i);
        }),
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(Promise.all(all)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
      expect(startedAt).toEqual([0, 0, 0, 500, 1_000, 1_500]);
    });

    it("refills the bucket while the queue is idle", async () => {
      __schedulerTest__.configure({ BURST_TOKENS: 2, RATE_PER_SECOND: 2, MAX_CONCURRENT: 10 });

      await scheduleWfmRequest(async () => ok(1));
      await scheduleWfmRequest(async () => ok(2));
      // Bucket is empty; one idle second buys two tokens back.
      await vi.advanceTimersByTimeAsync(1_000);

      const start = Date.now();
      const startedAt: number[] = [];
      const all = [1, 2].map(() =>
        scheduleWfmRequest(async () => {
          startedAt.push(Date.now() - start);
          return ok(null);
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all(all);

      expect(startedAt).toEqual([0, 0]);
    });
  });

  describe("concurrency cap", () => {
    it("never runs more than MAX_CONCURRENT sends at once", async () => {
      __schedulerTest__.configure({
        MAX_CONCURRENT: 2,
        MAX_BACKGROUND_CONCURRENT: 2,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const gates = Array.from({ length: 5 }, () => deferred<void>());
      let peak = 0;

      const all = gates.map((gate) =>
        scheduleWfmRequest(async () => {
          peak = Math.max(peak, __schedulerTest__.inFlight());
          await gate.promise;
          return ok(null);
        }),
      );

      await flush();
      expect(__schedulerTest__.inFlight()).toBe(2);

      gates[0].resolve();
      await flush();
      expect(__schedulerTest__.inFlight()).toBe(2);

      for (const gate of gates) gate.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all(all);
      expect(peak).toBe(2);
    });
  });

  describe("backoff", () => {
    it("grows exponentially, clamps at the ceiling and never dips below the base", async () => {
      __schedulerTest__.configure({
        MAX_RETRIES: 4,
        RETRY_BASE_MS: 100,
        RETRY_FACTOR: 2,
        RETRY_CEILING_MS: 300,
        RETRY_JITTER_RATIO: 0.25,
        MAX_RETRY_WAIT_MS: 100_000,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      vi.spyOn(Math, "random").mockReturnValue(0);
      const start = Date.now();
      const attemptsAt: number[] = [];
      const boom = new WfmApiError("boom", "WFM_API_ERROR", 503);

      const pending = scheduleWfmRequest(async () => {
        attemptsAt.push(Date.now() - start);
        return transientFailure(boom, { status: 503 });
      });
      const settled = pending.catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(settled).resolves.toBe(boom);
      // 100, 200, 300 (clamped from 400), 300.
      expect(attemptsAt).toEqual([0, 100, 300, 600, 900]);
    });

    it("keeps the jitter inside [base, base * (1 + ratio))", async () => {
      __schedulerTest__.configure({
        MAX_RETRIES: 1,
        RETRY_BASE_MS: 100,
        RETRY_CEILING_MS: 100,
        RETRY_JITTER_RATIO: 0.25,
        MAX_RETRY_WAIT_MS: 100_000,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const boom = new Error("boom");

      const gapFor = async (random: number): Promise<number> => {
        vi.spyOn(Math, "random").mockReturnValue(random);
        const start = Date.now();
        const attemptsAt: number[] = [];
        const settled = scheduleWfmRequest(async () => {
          attemptsAt.push(Date.now() - start);
          return transientFailure(boom);
        }).catch(() => null);
        await vi.advanceTimersByTimeAsync(1_000);
        await settled;
        return attemptsAt[1];
      };

      expect(await gapFor(0)).toBe(100);
      expect(await gapFor(0.5)).toBeGreaterThanOrEqual(112);
      expect(await gapFor(0.5)).toBeLessThanOrEqual(113);
      // Upper bound is exclusive at random() === 1, which Math.random never returns.
      expect(await gapFor(0.999)).toBeLessThan(125);
      expect(await gapFor(0.999)).toBeGreaterThanOrEqual(100);
    });

    it("stops retrying at the ceiling of attempts and throws the original error", async () => {
      __schedulerTest__.configure({
        MAX_RETRIES: 2,
        RETRY_BASE_MS: 10,
        RETRY_CEILING_MS: 10,
        MAX_RETRY_WAIT_MS: 100_000,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const boom = new WfmApiError("WFMClient network error: socket hang up", "WFM_NETWORK_ERROR");
      let sends = 0;

      const settled = scheduleWfmRequest(async () => {
        sends++;
        return transientFailure(boom);
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(settled).resolves.toBe(boom);
      expect(sends).toBe(3);
    });

    it("never retries an outcome the caller marked unreplayable", async () => {
      const boom = new WfmApiError("WFMClient API error: HTTP 503", "WFM_API_ERROR", 503);
      let sends = 0;

      const settled = scheduleWfmRequest(async () => {
        sends++;
        return {
          kind: "failure" as const,
          error: boom,
          status: 503,
          retryable: false,
          transient: true,
        };
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(100);
      await expect(settled).resolves.toBe(boom);
      expect(sends).toBe(1);
    });
  });

  describe("rate limiting", () => {
    it("honours a short Retry-After and retries once the gate lifts", async () => {
      __schedulerTest__.configure({ BURST_TOKENS: 50, RATE_PER_SECOND: 10_000 });
      vi.spyOn(Math, "random").mockReturnValue(0);
      const start = Date.now();
      const attemptsAt: number[] = [];
      let sends = 0;

      const pending = scheduleWfmRequest(async () => {
        attemptsAt.push(Date.now() - start);
        if (sends++ === 0) {
          return transientFailure<string>(new WfmApiError("limited", "WFM_RATE_LIMITED", 429), {
            status: 429,
            retryAfterMs: 1_500,
          });
        }
        return ok("done");
      });

      await vi.advanceTimersByTimeAsync(1_400);
      expect(attemptsAt).toEqual([0]);
      expect(getWfmSchedulerHealth().state).toBe("backoff");

      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toBe("done");
      expect(attemptsAt).toEqual([0, 1_500]);
    });

    it("fails fast on a 429 whose cooldown outlasts MAX_RETRY_WAIT_MS", async () => {
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      let sends = 0;

      const settled = scheduleWfmRequest(async () => {
        sends++;
        return transientFailure(limited, { status: 429, retryAfterMs: 30_000 });
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(10);
      await expect(settled).resolves.toBe(limited);
      expect(sends).toBe(1);

      const health = getWfmSchedulerHealth();
      expect(health.state).toBe("backoff");
      expect(health.backoffUntil).toBe(Date.now() + 29_990);
    });

    it("rejects an interactive request whose admission wait outlasts MAX_RETRY_WAIT_MS", async () => {
      // MAX_QUEUE_DEPTH 1 proves the rejected request gave its queue slot back:
      // a leaked slot would answer the second call with WFM_QUEUE_FULL.
      __schedulerTest__.configure({ MAX_RETRIES: 0, MAX_QUEUE_DEPTH: 1 });
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      await scheduleWfmRequest(async () =>
        transientFailure(limited, { status: 429, retryAfterMs: 120_000 }),
      ).catch(() => null);

      let sends = 0;
      for (let i = 0; i < 2; i++) {
        const settled = scheduleWfmRequest(async () => {
          sends++;
          return ok("never");
        }).catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(10);
        await expect(settled).resolves.toMatchObject({
          name: "WfmApiError",
          code: "WFM_RATE_LIMITED",
          status: 429,
          message: "Warframe.market rate limit hit. Please wait 120s before trying again.",
        });
      }
      expect(sends).toBe(0);
      expect(__schedulerTest__.inFlight()).toBe(0);
    });

    it("drops an interactive request that was already queued when the gate arms", async () => {
      __schedulerTest__.configure({
        MAX_RETRIES: 0,
        MAX_CONCURRENT: 5,
        // One token per 2s, so the second request is token-starved rather than
        // concurrency-blocked and is still pending when the gate arms.
        BURST_TOKENS: 1,
        RATE_PER_SECOND: 0.5,
      });
      const hold = deferred<void>();
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      const running = scheduleWfmRequest(async () => {
        await hold.promise;
        return transientFailure<string>(limited, { status: 429, retryAfterMs: 90_000 });
      }).catch(() => null);
      await flush();

      let sends = 0;
      const queued = scheduleWfmRequest(async () => {
        sends++;
        return ok("never");
      }).catch((err: unknown) => err);

      hold.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await running;
      await expect(queued).resolves.toMatchObject({
        name: "WfmApiError",
        code: "WFM_RATE_LIMITED",
        status: 429,
      });
      expect(sends).toBe(0);
    });

    it("keeps background work waiting for a gate longer than the interactive bound", async () => {
      __schedulerTest__.configure({ MAX_RETRIES: 0 });
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      await scheduleWfmRequest(async () =>
        transientFailure(limited, { status: 429, retryAfterMs: 60_000 }),
      ).catch(() => null);

      const start = Date.now();
      let ranAt = -1;
      const pending = scheduleWfmRequest(
        async () => {
          ranAt = Date.now() - start;
          return ok("sweep");
        },
        { priority: "background" },
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(ranAt).toBe(-1);

      await vi.advanceTimersByTimeAsync(31_000);
      await expect(pending).resolves.toBe("sweep");
      expect(ranAt).toBeGreaterThanOrEqual(60_000);
    });

    it("holds every later request behind the gate, then recovers", async () => {
      __schedulerTest__.configure({ MAX_RETRIES: 0 });
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      await scheduleWfmRequest(async () =>
        transientFailure(limited, { status: 429, retryAfterMs: 5_000 }),
      ).catch(() => null);

      const start = Date.now();
      let ranAt = -1;
      const pending = scheduleWfmRequest(async () => {
        ranAt = Date.now() - start;
        return ok("late");
      });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(ranAt).toBe(-1);

      await vi.advanceTimersByTimeAsync(1_100);
      await expect(pending).resolves.toBe("late");
      expect(ranAt).toBeGreaterThanOrEqual(5_000);
      expect(getWfmSchedulerHealth().state).toBe("ok");
    });

    it("paces from the gate release instead of releasing the whole bucket", async () => {
      __schedulerTest__.configure({
        BURST_TOKENS: 5,
        RATE_PER_SECOND: 2,
        MAX_CONCURRENT: 10,
        MAX_RETRIES: 0,
      });
      const limited = new WfmApiError("limited", "WFM_RATE_LIMITED", 429);
      await scheduleWfmRequest(async () =>
        transientFailure(limited, { status: 429, retryAfterMs: 5_000 }),
      ).catch(() => null);

      const start = Date.now();
      const startedAt: number[] = [];
      const all = Array.from({ length: 4 }, () =>
        scheduleWfmRequest(async () => {
          startedAt.push(Date.now() - start);
          return ok(null);
        }),
      );

      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.all(all);
      // Tokens accrued during the gate would have fired all four at once.
      expect(startedAt).toEqual([5_000, 5_500, 6_000, 6_500]);
    });
  });

  describe("health", () => {
    it("reports degraded once transient failures pile up, and clears with the window", async () => {
      __schedulerTest__.configure({
        DEGRADED_FAILURES: 3,
        FAILURE_WINDOW_MS: 10_000,
        MAX_RETRIES: 0,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const boom = new Error("boom");

      for (let i = 0; i < 3; i++) {
        await scheduleWfmRequest(async () => transientFailure(boom)).catch(() => null);
      }
      expect(getWfmSchedulerHealth()).toMatchObject({ state: "degraded", recentFailures: 3 });

      await vi.advanceTimersByTimeAsync(11_000);
      expect(getWfmSchedulerHealth()).toEqual({ state: "ok", recentFailures: 0 });
    });

    it("starts clean and keeps the shipped budget conservative", () => {
      const health: WfmSchedulerHealth = getWfmSchedulerHealth();
      expect(health).toEqual({ state: "ok", recentFailures: 0 });
      // WFM bans on sustained bursts; raising either number needs a real reason.
      expect(WFM_SCHEDULER_DEFAULTS.RATE_PER_SECOND).toBeLessThanOrEqual(3);
      expect(WFM_SCHEDULER_DEFAULTS.BURST_TOKENS).toBeLessThanOrEqual(10);
      expect(WFM_SCHEDULER_DEFAULTS.MAX_BACKGROUND_CONCURRENT).toBeLessThan(
        WFM_SCHEDULER_DEFAULTS.MAX_CONCURRENT,
      );
    });

    it("ignores permanent answers", async () => {
      const notFound = new WfmApiError("gone", "WFM_API_ERROR", 404);
      await scheduleWfmRequest(async () => ({
        kind: "failure" as const,
        error: notFound,
        status: 404,
        retryable: false,
        transient: false,
      })).catch(() => null);

      expect(getWfmSchedulerHealth()).toEqual({ state: "ok", recentFailures: 0 });
    });
  });

  describe("priority", () => {
    it("admits an interactive request ahead of queued background work", async () => {
      __schedulerTest__.configure({
        MAX_CONCURRENT: 1,
        MAX_BACKGROUND_CONCURRENT: 1,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const hold = deferred<void>();
      const order: string[] = [];

      const running = scheduleWfmRequest(
        async () => {
          order.push("running");
          await hold.promise;
          return ok(null);
        },
        { priority: "background" },
      );
      await flush();

      const queued = ["bg-1", "bg-2"].map((name) =>
        scheduleWfmRequest(
          async () => {
            order.push(name);
            return ok(null);
          },
          { priority: "background" },
        ),
      );
      const interactive = scheduleWfmRequest(async () => {
        order.push("interactive");
        return ok(null);
      });

      hold.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([running, interactive, ...queued]);

      expect(order).toEqual(["running", "interactive", "bg-1", "bg-2"]);
    });

    it("keeps a concurrency slot free so background sweeps cannot block a user call", async () => {
      __schedulerTest__.configure({
        MAX_CONCURRENT: 2,
        MAX_BACKGROUND_CONCURRENT: 1,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const holds = Array.from({ length: 3 }, () => deferred<void>());
      let interactiveRan = false;

      const sweeps = holds.map((hold) =>
        scheduleWfmRequest(
          async () => {
            await hold.promise;
            return ok(null);
          },
          { priority: "background" },
        ),
      );
      await flush();
      expect(__schedulerTest__.inFlight()).toBe(1);

      const interactive = scheduleWfmRequest(async () => {
        interactiveRan = true;
        return ok(null);
      });
      await flush();
      expect(interactiveRan).toBe(true);

      for (const hold of holds) hold.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([interactive, ...sweeps]);
    });
  });

  describe("queue depth", () => {
    it("rejects a submission past MAX_QUEUE_DEPTH with the WFM_QUEUE_FULL shape", async () => {
      __schedulerTest__.configure({
        MAX_QUEUE_DEPTH: 2,
        MAX_CONCURRENT: 1,
        BURST_TOKENS: 50,
        RATE_PER_SECOND: 10_000,
      });
      const hold = deferred<void>();
      const held = [1, 2].map(() =>
        scheduleWfmRequest(async () => {
          await hold.promise;
          return ok(null);
        }),
      );
      await flush();

      await expect(scheduleWfmRequest(async () => ok(null))).rejects.toMatchObject({
        name: "WfmApiError",
        code: "WFM_QUEUE_FULL",
        message: "WFM request queue full (2/2) - backend likely unavailable.",
      });

      hold.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all(held);
    });
  });

  it("lets an exception thrown by the task escape unchanged and frees the slot", async () => {
    const thrown = new WfmApiError("bad json", "WFM_INVALID_JSON", 200);

    await expect(
      scheduleWfmRequest(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);

    expect(__schedulerTest__.inFlight()).toBe(0);
    await expect(scheduleWfmRequest(async () => ok("next"))).resolves.toBe("next");
  });
});
