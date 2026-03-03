import { writable } from "svelte/store";

export type HeavyViewName = "world" | "market" | "relics";

export interface PerfSnapshot {
  startupInteractiveMs: number | null;
  relicWarmupFirstUsefulMs: number | null;
  relicWarmupCompleteMs: number | null;
  heavyViewOpenMs: Record<HeavyViewName, number | null>;
  marks: Record<string, number>;
}

const DEFAULT_HEAVY_VIEW_OPEN_MS: Record<HeavyViewName, number | null> = {
  world: null,
  market: null,
  relics: null,
};

const perfStartMs = nowMs();
const markTable = new Map<string, number>();

export const perfSnapshot = writable<PerfSnapshot>({
  startupInteractiveMs: null,
  relicWarmupFirstUsefulMs: null,
  relicWarmupCompleteMs: null,
  heavyViewOpenMs: { ...DEFAULT_HEAVY_VIEW_OPEN_MS },
  marks: {},
});

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function toRoundedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function setMark(label: string, valueMs: number): void {
  markTable.set(label, valueMs);
  perfSnapshot.update((current) => ({
    ...current,
    marks: {
      ...current.marks,
      [label]: toRoundedMs(valueMs),
    },
  }));
}

function markSinceStart(label: string): number {
  const elapsedMs = nowMs() - perfStartMs;
  setMark(label, elapsedMs);
  return elapsedMs;
}

export function markStartupInteractive(): void {
  perfSnapshot.update((current) => {
    if (current.startupInteractiveMs != null) return current;
    const elapsedMs = toRoundedMs(markSinceStart("startup-interactive"));
    return {
      ...current,
      startupInteractiveMs: elapsedMs,
    };
  });
}

export function beginHeavyViewOpen(view: HeavyViewName): void {
  setMark(`view-open-start:${view}`, nowMs());
}

export function completeHeavyViewOpen(view: HeavyViewName): void {
  const startMs = markTable.get(`view-open-start:${view}`);
  if (startMs == null) return;

  const durationMs = toRoundedMs(nowMs() - startMs);
  perfSnapshot.update((current) => ({
    ...current,
    heavyViewOpenMs: {
      ...current.heavyViewOpenMs,
      [view]: durationMs,
    },
  }));
  setMark(`view-open:${view}`, durationMs);
}

export function markRelicWarmupFirstUseful(): void {
  perfSnapshot.update((current) => {
    if (current.relicWarmupFirstUsefulMs != null) return current;
    const elapsedMs = toRoundedMs(markSinceStart("relic-warmup-first-useful"));
    return {
      ...current,
      relicWarmupFirstUsefulMs: elapsedMs,
    };
  });
}

export function markRelicWarmupComplete(): void {
  perfSnapshot.update((current) => {
    if (current.relicWarmupCompleteMs != null) return current;
    const elapsedMs = toRoundedMs(markSinceStart("relic-warmup-complete"));
    return {
      ...current,
      relicWarmupCompleteMs: elapsedMs,
    };
  });
}

export function resetPerfMetrics(): void {
  markTable.clear();
  perfSnapshot.set({
    startupInteractiveMs: null,
    relicWarmupFirstUsefulMs: null,
    relicWarmupCompleteMs: null,
    heavyViewOpenMs: { ...DEFAULT_HEAVY_VIEW_OPEN_MS },
    marks: {},
  });
}

