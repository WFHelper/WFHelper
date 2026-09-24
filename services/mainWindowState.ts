import { screen, type BrowserWindow } from "electron";

import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";

const log = withScope("mainWindowState");

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MainWindowState extends WindowBounds {
  maximized: boolean;
}

interface MinWindowSize {
  width: number;
  height: number;
}

function overlapArea(bounds: WindowBounds, area: WindowBounds): number {
  const x = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const y = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return x > 0 && y > 0 ? x * y : 0;
}

// Clamp onto the work area the bounds overlap most; null when no display holds
// any of them, so a detached monitor cannot strand the window offscreen.
export function fitBoundsToDisplays(
  bounds: WindowBounds,
  workAreas: ReadonlyArray<WindowBounds>,
  min: MinWindowSize,
): WindowBounds | null {
  let best: WindowBounds | null = null;
  let bestOverlap = 0;
  for (const area of workAreas) {
    const overlap = overlapArea(bounds, area);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = area;
    }
  }
  if (!best) return null;

  const width = Math.max(min.width, Math.min(bounds.width, best.width));
  const height = Math.max(min.height, Math.min(bounds.height, best.height));
  return {
    width,
    height,
    x:
      width > best.width
        ? best.x
        : Math.round(Math.min(Math.max(bounds.x, best.x), best.x + best.width - width)),
    y:
      height > best.height
        ? best.y
        : Math.round(Math.min(Math.max(bounds.y, best.y), best.y + best.height - height)),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const stateCache = createJsonCache<MainWindowState>("main-window-state.json", (parsed) => {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  const { x, y, width, height } = raw;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  return { x, y, width, height, maximized: raw.maximized === true };
});

/** Reopen on the last monitor, clamped so a resized display cannot hide it. */
export function loadMainWindowState(min: MinWindowSize): MainWindowState | null {
  const raw = stateCache.read();
  if (!raw) return null;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const fitted = fitBoundsToDisplays(raw, workAreas, min);
  return fitted ? { ...fitted, maximized: raw.maximized } : null;
}

/** maximizePending: the window is still to be maximized, so it counts as maximized. */
export function saveMainWindowState(win: BrowserWindow, maximizePending = false): void {
  if (win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized() || maximizePending;
    const state: MainWindowState = { ...win.getNormalBounds(), maximized };
    stateCache.write(state);
  } catch (err) {
    log.warn("[Main] window state save failed:", err);
  }
}
