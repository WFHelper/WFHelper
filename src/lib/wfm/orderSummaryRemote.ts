import {
  fetchBackendOrderSummaryBySlug,
  normalizeWfmSlug,
  type BackendFetchResult,
  type BackendOrderSummaryPayload,
} from "./backendLite.js";
import { normalizeRankFilter } from "../../../config/shared/numeric.js";

const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 90_000;
// Cap concurrent backend order-summary fetches so a cold page load with
// thousands of mods doesn't slam the worker with hundreds of parallel requests.
const MAX_CONCURRENT_FETCHES = 30;

const inFlightByKey = new Map<string, Promise<BackendFetchResult<BackendOrderSummaryPayload>>>();
let _activeFetches = 0;
const _fetchQueue: Array<() => void> = [];

function acquireFetchSlot(): Promise<void> {
  if (_activeFetches < MAX_CONCURRENT_FETCHES) {
    _activeFetches++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _fetchQueue.push(resolve);
  });
}

function releaseFetchSlot(): void {
  const next = _fetchQueue.shift();
  if (next) {
    next(); // transfer slot directly — _activeFetches stays the same
  } else {
    _activeFetches--;
  }
}

export interface OrderSummaryDebugCounters {
  requests: number;
  backendHitOk: number;
  backendHitNoData: number;
  backendError: number;
  breakerOpen: number;
}

let transientStreak = 0;
let breakerOpenUntil = 0;

const debugCounters: OrderSummaryDebugCounters = {
  requests: 0,
  backendHitOk: 0,
  backendHitNoData: 0,
  backendError: 0,
  breakerOpen: 0,
};

function bumpCounter(counter: keyof OrderSummaryDebugCounters): void {
  debugCounters[counter] += 1;
}

function noteTransientFailure(): void {
  transientStreak += 1;
  if (transientStreak >= CIRCUIT_BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    bumpCounter("breakerOpen");
  }
}

function noteRecovery(): void {
  transientStreak = 0;
  breakerOpenUntil = 0;
}

export function getOrderSummaryDebugCounters(): OrderSummaryDebugCounters {
  return { ...debugCounters };
}

function getOrderSummaryCircuitState(): { open: boolean; retryAfterMs: number } {
  const retryAfterMs = Math.max(0, breakerOpenUntil - Date.now());
  return {
    open: retryAfterMs > 0,
    retryAfterMs,
  };
}

export function resetOrderSummaryDebugState(): void {
  transientStreak = 0;
  breakerOpenUntil = 0;
  for (const key of Object.keys(debugCounters) as Array<keyof OrderSummaryDebugCounters>) {
    debugCounters[key] = 0;
  }
}

export async function fetchOrderSummaryBySlug(
  slugInput: string | null | undefined,
  options?: { rank?: number | null },
): Promise<BackendFetchResult<BackendOrderSummaryPayload>> {
  const slug = normalizeWfmSlug(slugInput);
  if (!slug) return { status: "not_found" };

  bumpCounter("requests");
  const rank = normalizeRankFilter(options?.rank ?? null);
  const requestKey = rank == null ? slug : `${slug}:r${rank}`;

  const inFlight = inFlightByKey.get(requestKey);
  if (inFlight) return inFlight;

  const circuit = getOrderSummaryCircuitState();
  if (circuit.open) {
    bumpCounter("backendError");
    return { status: "unavailable" } as const;
  }

  const request = (async () => {
    await acquireFetchSlot();
    try {
      const result = await fetchBackendOrderSummaryBySlug(slug, { rank });
      if (result.status === "ok") {
        noteRecovery();
        bumpCounter("backendHitOk");
        return result;
      }

      if (result.status === "not_found") {
        noteRecovery();
        bumpCounter("backendHitNoData");
        return result;
      }

      noteTransientFailure();
      bumpCounter("backendError");
      return result.status === "error" ? ({ status: "unavailable" } as const) : result;
    } finally {
      releaseFetchSlot();
      inFlightByKey.delete(requestKey);
    }
  })();

  inFlightByKey.set(requestKey, request);
  return request;
}
