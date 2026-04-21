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

/* ---------------------------------------------------------------------------
 * Live performance HUD (dev-only)
 *
 * Tracks:
 *   - rolling FPS (1 s window) and 1%-low over the last 3 s
 *   - `longtask` entries (>50 ms) in the last 5 s, via PerformanceObserver
 *   - per-view mount → first-paint duration
 *
 * All data is published through `perfHudStore`. The HUD renderer
 * (`PerfHud.svelte`) is mounted only when `import.meta.env.DEV` is true, so
 * prod bundles still include this file but nothing drives the rAF loop.
 * ------------------------------------------------------------------------- */

export interface PerfHudSnapshot {
  fps: number;
  fpsLow1pct: number;
  longTasks5s: number;
  longTaskMaxMs: number;
  /** Mount time (ms) of the last view that called `measureViewMount`. */
  lastViewMount: { name: string; ms: number } | null;
  /** All per-view mount samples in this session, last 8 kept. */
  viewMountHistory: { name: string; ms: number }[];
}

export const perfHudStore = writable<PerfHudSnapshot>({
  fps: 0,
  fpsLow1pct: 0,
  longTasks5s: 0,
  longTaskMaxMs: 0,
  lastViewMount: null,
  viewMountHistory: [],
});

let _hudStarted = false;
let _rafHandle: number | null = null;
let _longTaskObserver: PerformanceObserver | null = null;
/** Frame-time samples from the last ~3 s (rolling ring buffer). */
const _frameSamples: number[] = [];
/** Long-task entries (timestamp ms, duration ms) in the last 5 s. */
const _longTasks: { t: number; d: number }[] = [];

export function startPerfHudTracking(): void {
  if (_hudStarted) return;
  if (typeof window === "undefined" || typeof requestAnimationFrame === "undefined") return;
  _hudStarted = true;

  let lastFrame = performance.now();
  const tick = (now: number) => {
    const delta = now - lastFrame;
    lastFrame = now;
    _frameSamples.push(delta);
    // Trim to ~3 s @ 240 Hz worst case.
    if (_frameSamples.length > 720) _frameSamples.splice(0, _frameSamples.length - 720);

    // Prune long-tasks older than 5 s.
    const cutoff = now - 5000;
    while (_longTasks.length && _longTasks[0].t < cutoff) _longTasks.shift();

    // Publish every ~250 ms to keep the UI cheap.
    if ((_tickCounter++ & 15) === 0) _publishHud();
    _rafHandle = requestAnimationFrame(tick);
  };
  _rafHandle = requestAnimationFrame(tick);

  // PerformanceObserver is the standard API for main-thread long tasks (>50 ms).
  // Not every platform supports it — we guard and silently skip.
  try {
    if (typeof PerformanceObserver !== "undefined") {
      const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
        .supportedEntryTypes;
      if (!types || types.includes("longtask")) {
        _longTaskObserver = new PerformanceObserver((list) => {
          const now = performance.now();
          for (const entry of list.getEntries()) {
            _longTasks.push({ t: now, d: entry.duration });
          }
        });
        _longTaskObserver.observe({ type: "longtask", buffered: true });
      }
    }
  } catch {
    /* best-effort */
  }
}

export function stopPerfHudTracking(): void {
  if (_rafHandle != null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }
  if (_longTaskObserver) {
    try { _longTaskObserver.disconnect(); } catch { /* noop */ }
    _longTaskObserver = null;
  }
  _frameSamples.length = 0;
  _longTasks.length = 0;
  _hudStarted = false;
}

let _tickCounter = 0;

function _publishHud(): void {
  if (_frameSamples.length === 0) return;
  // Use the last ~1 s of frames for the displayed FPS, last ~3 s for 1%-low.
  const last1s: number[] = [];
  let acc = 0;
  for (let i = _frameSamples.length - 1; i >= 0 && acc < 1000; i--) {
    last1s.push(_frameSamples[i]);
    acc += _frameSamples[i];
  }
  const fpsInstant = last1s.length > 0 ? 1000 / (acc / last1s.length) : 0;
  const sorted = [..._frameSamples].sort((a, b) => a - b);
  // 1%-low: 99th-percentile frame time → invert to fps.
  const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  const fpsLow1pct = sorted.length > 0 ? 1000 / sorted[p99Idx] : 0;

  let longTaskMaxMs = 0;
  for (const lt of _longTasks) if (lt.d > longTaskMaxMs) longTaskMaxMs = lt.d;

  perfHudStore.update((s) => ({
    ...s,
    fps: Math.round(fpsInstant),
    fpsLow1pct: Math.round(fpsLow1pct),
    longTasks5s: _longTasks.length,
    longTaskMaxMs: Math.round(longTaskMaxMs),
  }));
}

/**
 * Record the mount-to-first-paint time of a view. Call from `onMount` as:
 *   onMount(() => { const done = measureViewMount("inventory"); tick().then(done); });
 * or pass an async/await wrapper — the returned function commits the sample
 * when invoked.
 */
export function measureViewMount(name: string): () => void {
  const start = nowMs();
  return () => {
    const ms = Math.round(nowMs() - start);
    perfHudStore.update((s) => {
      const history = [...s.viewMountHistory, { name, ms }].slice(-8);
      return { ...s, lastViewMount: { name, ms }, viewMountHistory: history };
    });
    setMark(`view-mount:${name}`, ms);
  };
}

