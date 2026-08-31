import { isActiveOrderStatus } from "../../../config/shared/wfmOrders.js";

/** One competing sell listing, in the shape the order book already provides. */
export interface PricingListing {
  platinum: number;
  quantity: number;
  status: string | null;
  userName: string;
}

export interface PricingContext {
  sellListings: readonly PricingListing[];
  /** Our own live listing price for this item; null when we are not listed. */
  currentPrice: number | null;
  /** Excluded from the competition so we never undercut ourselves. */
  ownUserName?: string | null;
  /** Only ingame/online sellers count as competition. Default true. */
  activeOnly?: boolean;
}

/** Downward damping: a reprice may only follow the market down when enough
 *  listings actually sit below us AND the drop stays inside the item's bound. */
export interface DampingRule {
  minListingsBelow: number;
  maxDropPercent: number;
  /** Absolute plat ceiling for one reprice step; the smaller allowance binds. */
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
  | "target-margin"
  | "manual";

/** Picker order for the UI. */
export const WORKBENCH_STRATEGY_IDS: readonly WorkbenchStrategyId[] = [
  "match-cheapest",
  "cheapest-minus-one",
  "percent-offset",
  "bounded-cheapest-average",
  "target-margin",
  "manual",
];

export type StrategyConfig =
  | { id: "match-cheapest" }
  | { id: "cheapest-minus-one" }
  | { id: "percent-offset"; percent: number }
  | { id: "bounded-cheapest-average"; count: number; thresholdPercent: number }
  | { id: "target-margin"; costPlat: number; marginPercent: number }
  | { id: "manual"; price: number };

interface PriceSuggestionInputs {
  listingsConsidered: number;
  cheapest: number | null;
  average?: number;
  currentPrice?: number;
  listingsBelowCurrent?: number;
  costPlat?: number;
}

export interface PriceSuggestion {
  strategyId: WorkbenchStrategyId;
  /** Null when the strategy has nothing to price from (empty book). */
  price: number | null;
  /** 0..1 heuristic; carried with the suggestion so the UI can show doubt. */
  confidence: number;
  inputs: PriceSuggestionInputs;
  damping?: { applied: true; reason: "depth" | "max-drop"; undampedPrice: number };
}

function competition(ctx: PricingContext): PricingListing[] {
  const activeOnly = ctx.activeOnly !== false;
  const own = ctx.ownUserName ? ctx.ownUserName.toLowerCase() : null;
  return ctx.sellListings
    .filter((listing) => {
      if (own && listing.userName.toLowerCase() === own) return false;
      if (activeOnly && !isActiveOrderStatus(listing.status)) return false;
      return listing.platinum > 0;
    })
    .sort((a, b) => a.platinum - b.platinum);
}

function clampPrice(value: number): number {
  return Math.max(1, Math.round(value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function marketConfidence(considered: number): number {
  return round2(Math.min(1, considered / 5));
}

/** Allowed one-step drop for an item priced at `currentPrice`. */
export function maxAllowedDrop(currentPrice: number, rule: DampingRule): number {
  const percentBound = Math.floor((currentPrice * rule.maxDropPercent) / 100);
  return Math.max(1, Math.min(percentBound, rule.maxDropPlat));
}

function applyDamping(
  suggestion: PriceSuggestion,
  ctx: PricingContext,
  book: readonly PricingListing[],
  rule: DampingRule,
): PriceSuggestion {
  const current = ctx.currentPrice;
  if (current == null || suggestion.price == null || suggestion.price >= current) {
    return suggestion;
  }
  const listingsBelow = book.filter((listing) => listing.platinum < current).length;
  const inputs: PriceSuggestionInputs = {
    ...suggestion.inputs,
    currentPrice: current,
    listingsBelowCurrent: listingsBelow,
  };

  if (listingsBelow < rule.minListingsBelow) {
    // Thin undercutting does not justify a race to the bottom: hold the price.
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
  const cheapest = book.length > 0 ? book[0].platinum : null;

  if (config.id === "manual") {
    return {
      strategyId: "manual",
      price: clampPrice(config.price),
      confidence: 1,
      inputs: { listingsConsidered: book.length, cheapest },
    };
  }

  if (config.id === "target-margin") {
    const price = clampPrice(Math.ceil(config.costPlat * (1 + config.marginPercent / 100)));
    // Cost-based, so no market damping; confidence drops when the ask sits
    // above the cheapest competitor and is unlikely to move.
    const overpriced = cheapest != null && price > cheapest;
    return {
      strategyId: "target-margin",
      price,
      confidence: overpriced ? 0.3 : 0.6,
      inputs: { listingsConsidered: book.length, cheapest, costPlat: config.costPlat },
    };
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
        price: clampPrice(cheapest),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "cheapest-minus-one":
      suggestion = {
        strategyId: config.id,
        price: clampPrice(cheapest - 1),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "percent-offset":
      suggestion = {
        strategyId: config.id,
        price: clampPrice(cheapest * (1 + config.percent / 100)),
        confidence: marketConfidence(book.length),
        inputs: { listingsConsidered: book.length, cheapest },
      };
      break;
    case "bounded-cheapest-average": {
      const count = Math.max(1, Math.floor(config.count));
      const ceiling = cheapest * (1 + Math.max(0, config.thresholdPercent) / 100);
      const pool = book.filter((listing) => listing.platinum <= ceiling).slice(0, count);
      const average = pool.reduce((sum, listing) => sum + listing.platinum, 0) / pool.length;
      suggestion = {
        strategyId: config.id,
        price: clampPrice(average),
        // Confidence follows how much of the requested sample actually exists.
        confidence: round2(Math.min(1, pool.length / count)),
        inputs: { listingsConsidered: pool.length, cheapest, average: round2(average) },
      };
      break;
    }
  }

  return applyDamping(suggestion, ctx, book, rule);
}
