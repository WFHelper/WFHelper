import type { MarketAlertHit } from "../../../../config/shared/marketAlertTypes.js";
import { compareNullableNumber } from "../../../lib/filters.js";
import type { MessageKey } from "../../../lib/i18n.js";

export const ALERT_HIT_SORTS = [
  "newest",
  "oldest",
  "priceAsc",
  "priceDesc",
  "endoPerPlatDesc",
  "endoPerPlatAsc",
  "endoDesc",
  "endoAsc",
] as const;

type AlertHitSort = (typeof ALERT_HIT_SORTS)[number];

export const ALERT_HIT_SORT_LABELS: Record<AlertHitSort, MessageKey> = {
  newest: "marketAlerts.hitSort.newest",
  oldest: "marketAlerts.hitSort.oldest",
  priceAsc: "orderbook.sort.priceLowToHigh",
  priceDesc: "orderbook.sort.priceHighToLow",
  endoPerPlatDesc: "marketAlerts.hitSort.endoPerPlatDesc",
  endoPerPlatAsc: "marketAlerts.hitSort.endoPerPlatAsc",
  endoDesc: "marketAlerts.hitSort.endoDesc",
  endoAsc: "marketAlerts.hitSort.endoAsc",
};

interface ValueSort {
  read: (hit: MarketAlertHit) => number | null | undefined;
  direction: 1 | -1;
}

const VALUE_SORTS: Record<Exclude<AlertHitSort, "newest" | "oldest">, ValueSort> = {
  priceAsc: { read: (hit) => hit.platinum, direction: 1 },
  priceDesc: { read: (hit) => hit.platinum, direction: -1 },
  endoPerPlatDesc: { read: (hit) => hit.endoPerPlat, direction: -1 },
  endoPerPlatAsc: { read: (hit) => hit.endoPerPlat, direction: 1 },
  endoDesc: { read: (hit) => hit.endo, direction: -1 },
  endoAsc: { read: (hit) => hit.endo, direction: 1 },
};

/** Expects the history newest first, as the engine stores it, so the input
 *  position is the recency tie-break. Hits without the value go last. */
export function sortAlertHits(
  hits: readonly MarketAlertHit[],
  sort: AlertHitSort,
): MarketAlertHit[] {
  if (sort === "newest") return [...hits];
  if (sort === "oldest") return [...hits].reverse();
  const { read, direction } = VALUE_SORTS[sort];
  return hits
    .map((hit, index) => {
      const value = read(hit);
      return {
        hit,
        index,
        value: typeof value === "number" && Number.isFinite(value) ? value : null,
      };
    })
    .sort((a, b) => compareNullableNumber(a.value, b.value, direction) || a.index - b.index)
    .map((entry) => entry.hit);
}
