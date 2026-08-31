import { withScope } from "./logger";

const log = withScope("wfmScheduler");

/** Background work yields to anything a user is waiting on. */
export type WfmRequestPriority = "interactive" | "background";

export interface WfmSchedulerHealth {
  state: "ok" | "backoff" | "degraded";
  /** Epoch ms the global gate lifts; absent when nothing is gated. */
  backoffUntil?: number;
  recentFailures: number;
}

/** Everything the scheduler is tuned by, and the only place to change it. A
 *  concurrency cap is not a rate budget: WFM limits per IP, so parallel slots
 *  still burst as fast as latency allows. Both gates run on every call. */
export const WFM_SCHEDULER_DEFAULTS = {
  /** Sustained global budget across every main-process WFM call. */
  RATE_PER_SECOND: 2.5,
  /** Tokens a cold burst may spend before the sustained rate binds. */
  BURST_TOKENS: 5,
  MAX_CONCURRENT: 3,
  /** Background never takes the last slot, so an interactive call waits for
   *  the budget and never for a sweep. */
  MAX_BACKGROUND_CONCURRENT: 2,
  /** Submitted-but-unsettled requests before new ones are rejected. */
  MAX_QUEUE_DEPTH: 64,
  /** Extra sends after the first one. */
  MAX_RETRIES: 3,
  RETRY_BASE_MS: 750,
  RETRY_FACTOR: 2,
  RETRY_CEILING_MS: 2_500,
  /** Jitter is added on top, never subtracted: a Retry-After is a floor. */
  RETRY_JITTER_RATIO: 0.25,
  /** Holding a caller longer than this is worse than the error it would get,
   *  so the request fails now while the global gate still holds everyone. */
  MAX_RETRY_WAIT_MS: 10_000,
  /** Gate length for a 429 that carried no usable Retry-After. */
  DEFAULT_RATE_LIMIT_GATE_MS: 30_000,
  MIN_RATE_LIMIT_GATE_MS: 1_000,
  MAX_RATE_LIMIT_GATE_MS: 5 * 60_000,
  FAILURE_WINDOW_MS: 60_000,
  DEGRADED_FAILURES: 6,
} as const;

type WfmSchedulerTuning = { -readonly [K in keyof typeof WFM_SCHEDULER_DEFAULTS]: number };

const TUNING: WfmSchedulerTuning = { ...WFM_SCHEDULER_DEFAULTS };

export class WfmApiError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "WfmApiError";
    this.code = code;
    this.status = status;
  }
}

/** One error shape for a 429, whether the server sent it or the gate refused. */
export function rateLimitError(waitMs: number): WfmApiError {
  return new WfmApiError(
    `Warframe.market rate limit hit. Please wait ${Math.ceil(waitMs / 1_000)}s before trying again.`,
    "WFM_RATE_LIMITED",
    429,
  );
}

/** What one send produced. The caller classifies, because only it knows
 *  whether the request may be replayed and what error shape it owes. */
export type WfmAttemptOutcome<T> =
  | { kind: "ok"; value: T }
  | {
      kind: "failure";
      /** Thrown verbatim once retries stop, so error shape never changes. */
      error: Error;
      /** HTTP status when WFM answered at all. */
      status?: number;
      /** Server-stated wait, already in ms. */
      retryAfterMs?: number;
      /** False for a permanent answer or a request that must not be replayed. */
      retryable: boolean;
      /** Counts against health: overload or transport, not a 4xx answer. */
      transient: boolean;
    };

/** Handed to `attempt` so work that must not sit in an admitted slot - the CSRF
 *  page prefetch, and a Cloudflare challenge window that waits on the user -
 *  runs with the slot given back to whoever is queued. */
export interface WfmAttemptContext {
  runUnadmitted<R>(fn: () => Promise<R>): Promise<R>;
}

interface WfmScheduleOptions {
  priority?: WfmRequestPriority;
  label?: string;
}

interface PendingTask {
  priority: WfmRequestPriority;
  /** False for a re-entry after runUnadmitted: the attempt already paid a
   *  token, and charging again would double the rate cost of every mutation. */
  costsToken: boolean;
  admit: () => void;
  fail: (error: Error) => void;
}

let _tokens: number = TUNING.BURST_TOKENS;
let _lastRefillAt = Date.now();
let _inFlight = 0;
let _backgroundInFlight = 0;
let _submitted = 0;
let _gateUntil = 0;
let _failureTimes: number[] = [];
let _lastState: WfmSchedulerHealth["state"] = "ok";
const _pending: PendingTask[] = [];
let _pumpTimer: ReturnType<typeof setTimeout> | null = null;

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _refill(now: number): void {
  if (now <= _lastRefillAt) return;
  const gained = ((now - _lastRefillAt) / 1000) * TUNING.RATE_PER_SECOND;
  _tokens = Math.min(TUNING.BURST_TOKENS, _tokens + gained);
  _lastRefillAt = now;
}

function _nextIndex(): number {
  let background = -1;
  for (let i = 0; i < _pending.length; i++) {
    if (_pending[i].priority === "interactive") return i;
    if (background < 0) background = i;
  }
  // Floor of 1: a zero cap would strand background work forever rather than
  // just deprioritising it.
  const backgroundCap = Math.max(1, TUNING.MAX_BACKGROUND_CONCURRENT);
  if (background >= 0 && _backgroundInFlight < backgroundCap) return background;
  return -1;
}

function _schedulePump(delayMs: number): void {
  if (_pumpTimer) clearTimeout(_pumpTimer);
  _pumpTimer = setTimeout(
    () => {
      _pumpTimer = null;
      _pump();
    },
    Math.max(1, Math.ceil(delayMs)),
  );
}

/** The 429 gate can hold for minutes, so an interactive caller gets the same
 *  bound the retry path applies: waiting longer is worse than the rate-limit
 *  error it would get anyway. Background work keeps waiting for the gate. */
function _dropGatedInteractive(now: number): void {
  const waitMs = _gateUntil - now;
  if (waitMs <= TUNING.MAX_RETRY_WAIT_MS) return;
  for (let i = _pending.length - 1; i >= 0; i--) {
    if (_pending[i].priority !== "interactive") continue;
    const [task] = _pending.splice(i, 1);
    task.fail(rateLimitError(waitMs));
  }
}

function _pump(): void {
  if (_pending.length === 0) return;
  const now = Date.now();
  if (now < _gateUntil) {
    _dropGatedInteractive(now);
    if (_pending.length === 0) return;
    _schedulePump(_gateUntil - now);
    return;
  }
  _refill(now);

  while (_pending.length > 0 && _inFlight < TUNING.MAX_CONCURRENT) {
    const index = _nextIndex();
    if (index < 0) break;
    if (_pending[index].costsToken && _tokens < 1) break;
    const [task] = _pending.splice(index, 1);
    if (task.costsToken) _tokens -= 1;
    _inFlight++;
    if (task.priority === "background") _backgroundInFlight++;
    task.admit();
  }

  if (_pending.length === 0) return;
  // A concurrency-blocked or background-blocked queue is woken by _release;
  // only a token-starved one needs a timer.
  if (_inFlight >= TUNING.MAX_CONCURRENT || _nextIndex() < 0) return;
  _schedulePump(((1 - _tokens) / TUNING.RATE_PER_SECOND) * 1000);
}

function _acquire(priority: WfmRequestPriority, costsToken: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    _pending.push({ priority, costsToken, admit: resolve, fail: reject });
    _pump();
  });
}

function _release(priority: WfmRequestPriority): void {
  _inFlight--;
  if (priority === "background") _backgroundInFlight--;
  _pump();
}

function _pruneFailures(now: number): void {
  const cutoff = now - TUNING.FAILURE_WINDOW_MS;
  while (_failureTimes.length > 0 && _failureTimes[0] <= cutoff) _failureTimes.shift();
}

function _currentState(now: number): WfmSchedulerHealth["state"] {
  if (now < _gateUntil) return "backoff";
  if (_failureTimes.length >= TUNING.DEGRADED_FAILURES) return "degraded";
  return "ok";
}

function _logStateChange(now: number): void {
  const state = _currentState(now);
  if (state === _lastState) return;
  _lastState = state;
  log.info(`[WFMScheduler] health ${state} (recent failures: ${_failureTimes.length})`);
}

function _armRateLimitGate(retryAfterMs: number | undefined, label: string): void {
  const gateMs =
    retryAfterMs != null && Number.isFinite(retryAfterMs)
      ? Math.min(
          Math.max(retryAfterMs, TUNING.MIN_RATE_LIMIT_GATE_MS),
          TUNING.MAX_RATE_LIMIT_GATE_MS,
        )
      : TUNING.DEFAULT_RATE_LIMIT_GATE_MS;
  const until = Date.now() + gateMs;
  if (until <= _gateUntil) return;
  _gateUntil = until;
  // Tokens must not accrue across the gate: refilling over the whole gated
  // window would spend the full bucket the moment it lifts and re-trip the 429.
  _lastRefillAt = until;
  _tokens = Math.min(_tokens, 1);
  log.warn(`[${label}] WFM budget gated for ${Math.ceil(gateMs / 1000)}s`);
  // Settles whatever is already queued against the new gate instead of leaving
  // it to the next release, which may be minutes away.
  _pump();
}

/** Exponential with an upward jitter, or the server's own wait when it sent
 *  one. Never returns less than the global gate still owes. */
function _retryWaitMs(attemptNumber: number, retryAfterMs?: number): number {
  const base =
    retryAfterMs != null && Number.isFinite(retryAfterMs)
      ? Math.max(retryAfterMs, 0)
      : Math.min(
          TUNING.RETRY_BASE_MS * TUNING.RETRY_FACTOR ** (attemptNumber - 1),
          TUNING.RETRY_CEILING_MS,
        );
  const jittered = base + Math.random() * TUNING.RETRY_JITTER_RATIO * base;
  return Math.max(jittered, _gateUntil - Date.now());
}

/** Run one WFM request under the global budget, concurrency cap and backoff.
 *  `attempt` returns an outcome rather than throwing so the scheduler can
 *  replay it without ever rewriting the error the caller would have seen. */
export async function scheduleWfmRequest<T>(
  attempt: (attemptNumber: number, ctx: WfmAttemptContext) => Promise<WfmAttemptOutcome<T>>,
  options: WfmScheduleOptions = {},
): Promise<T> {
  const priority = options.priority ?? "interactive";
  const label = options.label ?? "WFMClient";
  if (_submitted >= TUNING.MAX_QUEUE_DEPTH) {
    throw new WfmApiError(
      `WFM request queue full (${_submitted}/${TUNING.MAX_QUEUE_DEPTH}) - backend likely unavailable.`,
      "WFM_QUEUE_FULL",
    );
  }
  _submitted++;
  try {
    for (let attemptNumber = 1; ; attemptNumber++) {
      let admitted = false;
      const ctx: WfmAttemptContext = {
        async runUnadmitted<R>(fn: () => Promise<R>): Promise<R> {
          if (!admitted) return fn();
          admitted = false;
          _release(priority);
          try {
            return await fn();
          } finally {
            // A re-entry the gate refuses leaves `admitted` false and throws
            // here, which is also what keeps the release below balanced.
            await _acquire(priority, false);
            admitted = true;
          }
        },
      };
      await _acquire(priority, true);
      admitted = true;
      let outcome: WfmAttemptOutcome<T>;
      try {
        outcome = await attempt(attemptNumber, ctx);
      } finally {
        if (admitted) _release(priority);
      }

      const now = Date.now();
      if (outcome.kind === "ok") {
        // One clean answer retires the oldest failure so health recovers with
        // WFM instead of only when the window rolls off.
        _failureTimes.shift();
        _pruneFailures(now);
        _logStateChange(now);
        return outcome.value;
      }

      if (outcome.transient) {
        _failureTimes.push(now);
        _pruneFailures(now);
      }
      if (outcome.status === 429) _armRateLimitGate(outcome.retryAfterMs, label);
      _logStateChange(Date.now());

      if (!outcome.retryable || attemptNumber > TUNING.MAX_RETRIES) throw outcome.error;
      const waitMs = _retryWaitMs(attemptNumber, outcome.retryAfterMs);
      if (waitMs > TUNING.MAX_RETRY_WAIT_MS) throw outcome.error;
      await _sleep(waitMs);
    }
  } finally {
    _submitted--;
  }
}

export function getWfmSchedulerHealth(): WfmSchedulerHealth {
  const now = Date.now();
  _pruneFailures(now);
  const health: WfmSchedulerHealth = {
    state: _currentState(now),
    recentFailures: _failureTimes.length,
  };
  if (now < _gateUntil) health.backoffUntil = _gateUntil;
  return health;
}

export const __schedulerTest__ = {
  reset(): void {
    if (_pumpTimer) clearTimeout(_pumpTimer);
    _pumpTimer = null;
    _pending.length = 0;
    Object.assign(TUNING, WFM_SCHEDULER_DEFAULTS);
    _tokens = TUNING.BURST_TOKENS;
    _lastRefillAt = Date.now();
    _inFlight = 0;
    _backgroundInFlight = 0;
    _submitted = 0;
    _gateUntil = 0;
    _failureTimes = [];
    _lastState = "ok";
  },
  configure(overrides: Partial<WfmSchedulerTuning>): void {
    Object.assign(TUNING, overrides);
    _tokens = Math.min(_tokens, TUNING.BURST_TOKENS);
  },
  inFlight(): number {
    return _inFlight;
  },
};
