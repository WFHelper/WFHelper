import type { InventoryBaseItem, ItemMetrics } from "../../lib/inventoryMarket.js";
import {
  normalizeRank,
  isRankedGroup,
  resolveRankedMaxRank as resolveRankedMaxRankForGroup,
} from "../../../config/shared/numeric.js";
export { isActiveOrderStatus } from "../../../config/shared/wfmOrders.js";

export function resolvePriceRank(item: InventoryBaseItem): number | null {
  if (!isRankedGroup(item.inventoryGroup)) return null;

  const fallbackMaxRank = resolveRankedMaxRankForGroup(item.inventoryGroup);
  const parsedMaxRank = normalizeRank((item as { maxRank?: unknown }).maxRank);
  const maxRank = parsedMaxRank != null && parsedMaxRank > 0 ? parsedMaxRank : fallbackMaxRank;
  const parsedCurrentRank = normalizeRank((item as { rank?: unknown }).rank);
  const currentRank = parsedCurrentRank != null ? parsedCurrentRank : 0;

  return currentRank >= maxRank ? maxRank : 0;
}

export function resolveRankedMaxRank(item: InventoryBaseItem): number | null {
  if (!isRankedGroup(item.inventoryGroup)) return null;

  const fallbackMaxRank = resolveRankedMaxRankForGroup(item.inventoryGroup);
  const parsedMaxRank = normalizeRank((item as { maxRank?: unknown }).maxRank);
  if (parsedMaxRank != null && parsedMaxRank > 0) {
    return parsedMaxRank;
  }
  return fallbackMaxRank;
}

export function priceRetryKey(itemKey: string, rank: number | null): string {
  return rank == null ? itemKey : `${itemKey}:r${rank}`;
}

export function orderRetryKey(itemKey: string, rank: number): string {
  return `${itemKey}:order:r${rank}`;
}

export function itemPriceRank(metric: ItemMetrics | undefined): number | null {
  return normalizeRank(metric?.priceRank) ?? null;
}

export function hasResolvedPrice(metric: ItemMetrics | undefined): boolean {
  if (metric?.hasPrice === true) {
    return true;
  }

  if (typeof metric?.platinum === "number" && Number.isFinite(metric.platinum)) {
    return true;
  }

  if (typeof metric?.platinumR0 === "number" && Number.isFinite(metric.platinumR0)) {
    return true;
  }

  if (typeof metric?.platinumRmax === "number" && Number.isFinite(metric.platinumRmax)) {
    return true;
  }

  return false;
}

export function hasRankPairCoverage(
  metric: ItemMetrics | undefined,
  item: InventoryBaseItem,
  needs: { orders?: boolean },
): boolean {
  if (!isRankedGroup(item.inventoryGroup)) return true;

  const hasPricePair = metric?.hasPriceR0 === true && metric?.hasPriceRmax === true;
  if (!hasPricePair) return false;
  if (!needs.orders) return true;
  if (item.tradable !== true) return true;

  return metric?.hasOrdersR0 === true && metric?.hasOrdersRmax === true;
}
