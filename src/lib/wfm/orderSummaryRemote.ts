import {
  fetchBackendOrderSummaryBySlug,
  normalizeWfmSlug,
  type BackendFetchResult,
  type BackendOrderSummaryPayload,
} from "./backendLite.js";
import { normalizeRankFilter } from "../../../config/shared/numeric.js";
import { rendererRankedRequestKey } from "../../../config/shared/wfmCacheKeys.js";
import {
  createCircuitBreaker,
  createConcurrencyLimiter,
  createSingleFlightMap,
} from "./requestPolicy.js";

const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 90_000;
// Cap concurrent backend order-summary fetches so a cold page load with
// thousands of mods doesn't slam the worker with hundreds of parallel requests.
const MAX_CONCURRENT_FETCHES = 30;

const fetchLimiter = createConcurrencyLimiter(MAX_CONCURRENT_FETCHES);
const inFlightByKey = createSingleFlightMap<
  string,
  BackendFetchResult<BackendOrderSummaryPayload>
>();

export interface OrderSummaryDebugCounters {
  requests: number;
  backendHitOk: number;
  backendHitNoData: number;
  backendError: number;
  breakerOpen: number;
}

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

const breaker = createCircuitBreaker({
  threshold: CIRCUIT_BREAKER_THRESHOLD,
  cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
  onOpen: () => bumpCounter("breakerOpen"),
});

export function getOrderSummaryDebugCounters(): OrderSummaryDebugCounters {
  return { ...debugCounters };
}

function getOrderSummaryCircuitState(): { open: boolean; retryAfterMs: number } {
  return breaker.state();
}

export function resetOrderSummaryDebugState(): void {
  breaker.reset();
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
  const requestKey = rendererRankedRequestKey(slug, rank);

  const inFlight = inFlightByKey.get(requestKey);
  if (inFlight) return inFlight;

  const circuit = getOrderSummaryCircuitState();
  if (circuit.open) {
    bumpCounter("backendError");
    return { status: "unavailable" } as const;
  }

  return inFlightByKey.run(requestKey, async () => {
    await fetchLimiter.acquire();
    try {
      const result = await fetchBackendOrderSummaryBySlug(slug, { rank });
      if (result.status === "ok") {
        breaker.noteSuccess();
        bumpCounter("backendHitOk");
        return result;
      }

      if (result.status === "not_found") {
        breaker.noteSuccess();
        bumpCounter("backendHitNoData");
        return result;
      }

      breaker.noteFailure();
      bumpCounter("backendError");
      return result.status === "error" ? ({ status: "unavailable" } as const) : result;
    } finally {
      fetchLimiter.release();
    }
  });
}
