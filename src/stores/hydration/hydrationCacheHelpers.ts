import { getCachedPriceState } from "../../lib/wfm/priceCache.js";
import {
  getCachedOrderSummaryState,
  isOrderSummaryFresh,
} from "../../lib/wfm/orderSummaryCache.js";
import type { InventoryBaseItem } from "../../lib/inventoryMarket.js";
import { resolveRankedMaxRank } from "./hydrationHelpers.js";
import { isRankedGroup } from "../../../config/shared/numeric.js";
import { rendererPriceCacheKey } from "../../../config/shared/wfmCacheKeys.js";

export function getCachedMedian(cacheKey: string): number | null {
  const entry = getCachedPriceState(cacheKey);
  if (!entry || entry.status !== "ok") return null;
  return typeof entry.median === "number" && Number.isFinite(entry.median) ? entry.median : null;
}

export function hasCachedRankPair(item: InventoryBaseItem): boolean {
  if (!isRankedGroup(item.inventoryGroup) || !item.marketSlug) {
    return false;
  }

  const maxRank = resolveRankedMaxRank(item);
  if (maxRank == null) return false;

  const r0 = getCachedMedian(rendererPriceCacheKey(item.marketSlug, 0));
  const rmax = getCachedMedian(rendererPriceCacheKey(item.marketSlug, maxRank));
  return r0 != null && rmax != null;
}

export function getCachedRankOrderSummary(
  slugInput: string | null | undefined,
  rank: number,
): {
  wts: number | null;
  wtb: number | null;
  fresh: boolean;
} | null {
  const summary = getCachedOrderSummaryState(slugInput, rank, { allowStale: true });
  if (!summary) return null;

  const wts =
    typeof summary.wts === "number" && Number.isFinite(summary.wts)
      ? Math.round(summary.wts)
      : null;
  const wtb =
    typeof summary.wtb === "number" && Number.isFinite(summary.wtb)
      ? Math.round(summary.wtb)
      : null;

  return {
    wts,
    wtb,
    fresh: isOrderSummaryFresh(summary),
  };
}

export function hasFreshOrderSummaryPair(
  slugInput: string | null | undefined,
  maxRank: number,
): boolean {
  const rank0 = getCachedOrderSummaryState(slugInput, 0);
  const rankMax = getCachedOrderSummaryState(slugInput, maxRank);
  return Boolean(rank0 && rankMax);
}
