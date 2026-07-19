import { clampNumber } from "../shared/numeric";

/** Bounds for the user's UI scale override, matching the overlay scale range. */
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;

// workArea heights are device-independent px, so this composes with Windows DPI scaling.
export function baseZoomForDisplayHeight(height: unknown): number {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return 1;
  if (h <= 720) return 0.8;
  if (h <= 900) return 0.9;
  if (h <= 1200) return 1;
  if (h <= 1600) return 1.15;
  return 1.3;
}

/** Display-derived base zoom times the user's override, clamped and rounded. */
export function computeUiZoomFactor(displayHeight: unknown, userScale: unknown): number {
  const scale = clampNumber(userScale, UI_SCALE_MIN, UI_SCALE_MAX, 1);
  return Number((baseZoomForDisplayHeight(displayHeight) * scale).toFixed(3));
}
