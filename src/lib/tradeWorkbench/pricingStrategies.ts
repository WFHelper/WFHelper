import {
  isActiveOrderStatus,
  listingUnitPrice,
  normalizePerTrade,
  type UnitPricedListing,
} from "../../../config/shared/wfmOrders.js";

export interface PricingListing extends UnitPricedListing {
  quantity: number;
  status: string | null;
  userName: string;
}

export interface PricingContext {
  sellListings: readonly PricingListing[];
  currentPrice: number | null;
  ownPerTrade?: number | null;
  ownUserName?: string | null;
  activeOnly?: boolean;
  /** Sale-price reference for a median strategy; the listing book never sets it. */
  median?: MedianReference | null;
}

export interface MedianReference {
  median: number;
  /** Trading days behind the median; null when the source does not count them. */
  days: number | null;
}

export interface DampingRule {
  minListingsBelow: number;
  maxDropPercent: number;
  maxDropPlat: number;
}

export const DEFAULT_DAMPING_RULE: DampingRule = {
  minListingsBelow: 3,
  maxDropPercent: 15,
  maxDropPlat: 30,
};

export type WorkbenchStrategyId =
  | "match-cheapest"
  | "cheapest-minus-one"
  | "percent-offset"
  | "bounded-cheapest-average"
  | "median-48h"
  | "median-90d"
  | "target-margin"
  | "manual";

export type MedianStrategyId = "median-48h" | "median-90d";

export const WORKBENCH_STRATEGY_IDS: readonly WorkbenchStrategyId[] = [
  "match-cheapest",
  "cheapest-minus-one",
  "percent-offset",
  "bounded-cheapest-average",
  "median-48h",
  "median-90d",
  "target-margin",
  "manual",
];

export function isMedianStrategy(id: WorkbenchStrategyId): id is MedianStrategyId {
  return id === "median-48h" || id === "median-90d";
}

export type StrategyConfig =
  | { id: "match-cheapest" }
  | { id: "cheapest-minus-one" }
  | { id: "percent-offset"; percent: number }
  | { id: "bounded-cheapest-average"; count: number; thresholdPercent: number }
  | { id: MedianStrategyId; offsetPlat: number }
  | { id: "target-margin"; costPlat: number; marginPercent: number }
  | { id: "manual" };

interface PriceSuggestionInputs {
  listingsConsidered: number;
  cheapest: number | null;
  average?: number;
  median?: number;
  medianDays?: number;
  currentPrice?: number;
  listingsBelowCurrent?: number;
  costPlat?: number;
}

export type WorkbenchDampingReason = "depth" | "max-drop";

export interface PriceSuggestion {
  strategyId: WorkbenchStrategyId;
  price: number | null;
  confidence: number;
  inputs: PriceSuggestionInputs;
  damping?: { applied: true; reason: WorkbenchDampingReason; undampedPrice: number };
}

function competition(ctx: PricingContext): PricingListing[] {
  const activeOnly = ctx.activeOnly !== false;
  const own = ctx.ownUserName ? ctx.ownUserName.toLowerCase() : null;
  return ctx.sellListings
    .filter((listing) => {
      if (own && listing.userName.toLowerCase() === own) return false;
      if (activeOnly && !isActiveOrderStatus(listing.status)) return false;
      return listingUnitPrice(listing) > 0;
    })
    .sort((a, b) => listingUnitPrice(a) - listingUnitPrice(b));
}

/** Null rather than a 1p floor: an input that cannot produce a real ask must leave
 *  the row unpriced instead of silently listing it for one platinum. */
function clampPrice(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? rounded : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function marketConfidence(considered: number): number {
  return round2(Math.min(1, considered / 5));
}

// The 48h snapshot carries no sale volume, so it gets a fixed middling confidence.
function medianConfidence(reference: MedianReference): number {
  return reference.days == null ? 0.5 : round2(Math.min(1, reference.days / 30));
}

export function maxAllowedDrop(currentPrice: number, rule: DampingRule): number {
  const percentBound = Math.floor((currentPrice * rule.maxDropPercent) / 100);
  return Math.max(1, Math.min(percentBound, rule.maxDropPlat));
}

function applyDamping(
  suggestion: PriceSuggestion,
  ctx: PricingContext,
  book: readonly PricingListing[],
  rule: DampingRule,
  perTrade: number,
): PriceSuggestion {
  const current = ctx.currentPrice;
  if (current == null || suggestion.price == null || suggestion.price >= current) {
    return suggestion;
  }
  const listingsBelow = book.filter(
    (listing) => listingUnitPrice(listing) * perTrade < current,
  ).length;
  const inputs: PriceSuggestionInputs = {
    ...suggestion.inputs,
    currentPrice: current,
    listingsBelowCurrent: listingsBelow,
  };

  if (listingsBelow < rule.minListingsBelow) {
    return {
      ...suggestion,
      price: current,
      confidence: round2(suggestion.confidence * 0.75),
      inputs,
      damping: { applied: true, reason: "depth", undampedPrice: suggestion.price },
    };
  }

  const allowedDrop = maxAllowedDrop(current, rule);
  if (current - suggestion.price > allowedDrop) {
    return {
      ...suggestion,
      price: current - allowedDrop,
      confidence: round2(suggestion.confidence * 0.75),
      inputs,
      damping: { applied: true, reason: "max-drop", undampedPrice: suggestion.price },
    };
  }

  return { ...suggestion, inputs };
}

export function suggestPrice(
  config: StrategyConfig,
  ctx: PricingContext,
  rule: DampingRule = DEFAULT_DAMPING_RULE,
): PriceSuggestion {
  const book = competition(ctx);
  const perTrade = normalizePerTrade(ctx.ownPerTrade);
  const listPrice = (unitValue: number): number | null => clampPrice(unitValue * perTrade);
  const cheapest = book.length > 0 ? listingUnitPrice(book[0]) : null;

  if (config.id === "manual") {
    return {
      strategyId: "manual",
      price: null,
      confidence: 0,
      inputs: { listingsConsidered: book.length, cheapest },
    };
  }

  if (config.id === "target-margin") {
    const unitAsk = Math.ceil(config.costPlat * (1 + config.marginPercent / 100));
    const price = listPrice(unitAsk);
    const overpriced = price != null && cheapest != null && unitAsk > cheapest;
    return {
      strategyId: "target-margin",
      price,
      confidence: price == null ? 0 : overpriced ? 0.3 : 0.6,
      inputs: { listingsConsidered: book.length, cheapest, costPlat: config.costPlat },
    };
  }

  if (config.id === "median-48h" || config.id === "median-90d") {
    const reference = ctx.median ?? null;
    const offset = Number.isFinite(config.offsetPlat) ? Math.round(config.offsetPlat) : 0;
    const inputs: PriceSuggestionInputs = { listingsConsidered: book.length, cheapest };
    if (!reference) return { strategyId: config.id, price: null, confidence: 0, inputs };
    inputs.median = round2(reference.median);
    if (reference.days != null) inputs.medianDays = reference.days;
    const price = listPrice(reference.median + offset);
    if (price == null) return { strategyId: config.id, price: null, confidence: 0, inputs };
    return applyDamping(
      { strategyId: config.id, price, confidence: medianConfidence(reference), inputs },
      ctx,
      book,
      rule,
      perTrade,
    );
  }

  if (cheapest == null) {
    return {
      strategyId: config.id,
      price: null,
      confidence: 0,
      inputs: { listingsConsidered: 0, cheapest: null },
    };
  }

  let suggestion: PriceSuggestion;
  switch (config.id) {
    case "match-cheapest":
      suggestion = {
        strategyId: config.id,
        price: listPrice(cheapest),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "cheapest-minus-one":
      suggestion = {
        strategyId: config.id,
        price: listPrice(Math.max(1, cheapest - 1)),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "percent-offset":
      suggestion = {
        strategyId: config.id,
        price: listPrice(cheapest * (1 + config.percent / 100)),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "bounded-cheapest-average": {
      const count = Math.max(1, Math.floor(config.count));
      const ceiling = cheapest * (1 + Math.max(0, config.thresholdPercent) / 100);
      const pool = book.filter((listing) => listingUnitPrice(listing) <= ceiling).slice(0, count);
      const average =
        pool.reduce((sum, listing) => sum + listingUnitPrice(listing), 0) / pool.length;
      suggestion = {
        strategyId: config.id,
        price: listPrice(average),
        confidence: round2(Math.min(1, pool.length / count)),
        inputs: { listingsConsidered: pool.length, cheapest, average: round2(average) },
      };
      break;
    }
  }

  if (suggestion.price == null) return { ...suggestion, confidence: 0 };
  return applyDamping(suggestion, ctx, book, rule, perTrade);
}
