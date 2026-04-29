import type { SortedItem } from "./rewardScannerMatch";
import { SCANNER_TUNING } from "./rewardScannerTuning";

interface TemporalEntry {
  items: SortedItem[];
  expectedCount: number;
  ts: number;
}

const recentScanEntries: TemporalEntry[] = [];

export function recordTemporalEntry(items: SortedItem[], expectedCount: number): void {
  recentScanEntries.push({ items: items.slice(), expectedCount, ts: Date.now() });
  while (recentScanEntries.length > SCANNER_TUNING.temporal.maxResults) recentScanEntries.shift();
}

export function findTemporalFallback(items: SortedItem[], expectedCount: number): SortedItem[] | null {
  if (items.length >= expectedCount) return null;
  const now = Date.now();
  const recent = recentScanEntries.filter(
    (entry) =>
      now - entry.ts < SCANNER_TUNING.temporal.windowMs && entry.items.length >= expectedCount,
  );
  if (recent.length < 2) return null;
  return recent[recent.length - 1].items;
}

export function resetTemporalEntries(): void {
  recentScanEntries.length = 0;
}
