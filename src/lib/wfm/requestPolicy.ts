interface CircuitBreakerOptions {
  threshold: number;
  cooldownMs: number;
  onOpen?: () => void;
}

export function createCircuitBreaker(options: CircuitBreakerOptions) {
  let transientStreak = 0;
  let openUntil = 0;

  return {
    noteFailure(): void {
      transientStreak += 1;
      if (transientStreak >= options.threshold) {
        openUntil = Date.now() + options.cooldownMs;
        options.onOpen?.();
      }
    },
    noteSuccess(): void {
      transientStreak = 0;
      openUntil = 0;
    },
    state(): { open: boolean; retryAfterMs: number } {
      const retryAfterMs = Math.max(0, openUntil - Date.now());
      return { open: retryAfterMs > 0, retryAfterMs };
    },
    reset(): void {
      transientStreak = 0;
      openUntil = 0;
    },
  };
}

export function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (active < maxConcurrent) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    },
    release(): void {
      const next = queue.shift();
      if (next) {
        next();
        return;
      }
      active = Math.max(0, active - 1);
    },
  };
}

export function createSingleFlightMap<K, V>() {
  const inFlight = new Map<K, Promise<V>>();

  return {
    get(key: K): Promise<V> | undefined {
      return inFlight.get(key);
    },
    run(key: K, taskFactory: () => Promise<V>): Promise<V> {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const task = taskFactory().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, task);
      return task;
    },
    delete(key: K): void {
      inFlight.delete(key);
    },
  };
}

interface QueueTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function createAdaptiveDelayController(options: {
  baseDelayMs: number;
  maxDelayMs: number;
  decayStepMs: number;
  backoffStepMs: number;
  minRateLimitCooldownMs: number;
}) {
  let lastRequestAt = 0;
  let delayMs = options.baseDelayMs;

  return {
    async waitForTurn(): Promise<void> {
      const now = Date.now();
      const elapsed = now - lastRequestAt;
      if (elapsed < delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs - elapsed));
      }
      lastRequestAt = Date.now();
    },
    noteRateLimited(retryAfterSeconds: number): void {
      delayMs = Math.min(options.maxDelayMs, delayMs + options.backoffStepMs);
      lastRequestAt =
        Date.now() + Math.max(retryAfterSeconds * 1000, options.minRateLimitCooldownMs) - delayMs;
    },
    noteSuccess(): void {
      if (delayMs > options.baseDelayMs) {
        delayMs = Math.max(options.baseDelayMs, delayMs - options.decayStepMs);
      }
    },
    getDelayMs(): number {
      return delayMs;
    },
    reset(): void {
      lastRequestAt = 0;
      delayMs = options.baseDelayMs;
    },
  };
}

export function createPriorityRequestQueue<P extends string>(options: {
  priorities: readonly P[];
  maxDepth: number;
  beforeTask?: () => Promise<void>;
  onDrop?: () => void;
  dropError?: () => Error;
}) {
  const queues = Object.fromEntries(
    options.priorities.map((priority) => [priority, []]),
  ) as unknown as Record<P, QueueTask<unknown>[]>;
  let runnerActive = false;

  function queuedTaskCount(): number {
    return options.priorities.reduce((total, priority) => total + queues[priority].length, 0);
  }

  function popNextTask(): QueueTask<unknown> | null {
    for (const priority of options.priorities) {
      const task = queues[priority].shift();
      if (task) return task;
    }
    return null;
  }

  async function runQueueRunner(): Promise<void> {
    if (runnerActive) return;
    runnerActive = true;

    try {
      for (;;) {
        const task = popNextTask();
        if (!task) break;
        if (options.beforeTask) await options.beforeTask();
        try {
          const result = await task.fn();
          task.resolve(result);
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      runnerActive = false;
      if (queuedTaskCount() > 0) void runQueueRunner();
    }
  }

  return {
    enqueue<T>(fn: () => Promise<T>, priority: P): Promise<T> {
      if (queuedTaskCount() >= options.maxDepth) {
        options.onDrop?.();
        return Promise.reject(
          options.dropError ? options.dropError() : new Error("REQUEST_QUEUE_FULL"),
        );
      }

      return new Promise<T>((resolve, reject) => {
        queues[priority].push({
          fn: fn as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        void runQueueRunner();
      });
    },
    lengths(): Record<P, number> {
      return Object.fromEntries(
        options.priorities.map((priority) => [priority, queues[priority].length]),
      ) as Record<P, number>;
    },
    isRunning(): boolean {
      return runnerActive;
    },
  };
}
