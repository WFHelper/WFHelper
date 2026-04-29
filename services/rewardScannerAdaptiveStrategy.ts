import { REWARD_STRATEGY_HISTORY_TTL_MS } from "../config/runtime/cacheConfig";
import { SCANNER_TUNING } from "./rewardScannerTuning";

interface StrategyWin {
  bandIndex: number;
  variantId: string;
  score: number;
  timestamp: number;
}

const strategyHistory: StrategyWin[] = [];

export function recordStrategyWin(bandIndex: number, variantId: string, score: number): void {
  strategyHistory.push({ bandIndex, variantId, score, timestamp: Date.now() });
  if (strategyHistory.length > SCANNER_TUNING.strategy.historyMax) {
    strategyHistory.shift();
  }
}

export function getAdaptiveStrategyHint(): { bandIndex: number; variantId: string } | null {
  const now = Date.now();
  const recent = strategyHistory.filter(
    (win) => now - win.timestamp < REWARD_STRATEGY_HISTORY_TTL_MS,
  );
  if (recent.length < 2) return null;

  const bandCounts = new Map<number, number>();
  const variantCounts = new Map<string, number>();
  for (const win of recent) {
    bandCounts.set(win.bandIndex, (bandCounts.get(win.bandIndex) || 0) + 1);
    variantCounts.set(win.variantId, (variantCounts.get(win.variantId) || 0) + 1);
  }

  let bestBand = -1;
  let bestBandCount = 0;
  for (const [band, count] of bandCounts) {
    if (count > bestBandCount) {
      bestBand = band;
      bestBandCount = count;
    }
  }

  let bestVariant = "raw";
  let bestVariantCount = 0;
  for (const [variant, count] of variantCounts) {
    if (count > bestVariantCount) {
      bestVariant = variant;
      bestVariantCount = count;
    }
  }

  return bestBand >= 0 ? { bandIndex: bestBand, variantId: bestVariant } : null;
}

export function resetAdaptiveStrategyHistory(): void {
  strategyHistory.length = 0;
}
