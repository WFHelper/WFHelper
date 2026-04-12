/**
 * Screen capture helpers for reward and riven scanning.
 * Uses GDI BitBlt via koffi as the sole capture method.
 */

import { withScope } from "./logger";
import { clampNumber } from "./rewardScannerUtils";
import { captureGdi } from "./dxgiCapture";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("rewardScanner");

export const CAPTURE_THUMBNAIL_LIMITS: Readonly<{
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}> = Object.freeze({
  minWidth: 1920,
  minHeight: 1080,
  maxWidth: 3200,
  maxHeight: 1800,
});

const COMPANION_WINDOW_TOKENS: ReadonlyArray<string> = Object.freeze([
  "warframe companion",
  "warframe-companion",
  "warframe_companion",
  "ocr crop debugger",
  "relic reward",
  "overlay",
  "visual studio code",
  "vscode",
  "github",
  "repository",
  "explorer",
  "file explorer",
]);

const WARFRAME_WINDOW_NAME_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([/^warframe\b/i]);

export function sourceName(source: any): string {
  return String(source?.name || "").trim();
}

export function isCompanionWindowSource(source: any): boolean {
  const name = sourceName(source).toLowerCase();
  return COMPANION_WINDOW_TOKENS.some((token) => name.includes(token));
}

export function isWarframeWindowSource(source: any): boolean {
  const name = sourceName(source).toLowerCase();
  if (!name.includes("warframe")) return false;
  if (isCompanionWindowSource(source)) return false;
  return WARFRAME_WINDOW_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function pickWindowSource(sources: any[]): any | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const candidates = sources.filter(isWarframeWindowSource);
  if (candidates.length === 0) return null;

  return (
    candidates.find((source) => /^warframe$/i.test(sourceName(source))) ||
    candidates.find((source) => /^warframe\s*[-:|].*$/i.test(sourceName(source))) ||
    candidates[0]
  );
}

export function isLikelyWrongWindowName(name: any): boolean {
  const low = String(name || "").toLowerCase();
  if (!low.includes("warframe")) return true;
  if (isCompanionWindowSource({ name: low })) return true;
  if (low.includes("github") || low.includes("readme") || low.includes("comparison.md"))
    return true;
  if (low.includes("visual studio") || low.includes("code")) return true;
  return false;
}

interface PickScreenOptions {
  preferredDisplayId?: string | null;
}

export function pickScreenSource(sources: any[], options: PickScreenOptions = {}): any | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const preferredDisplayId =
    options && typeof options.preferredDisplayId === "string" && options.preferredDisplayId.trim()
      ? options.preferredDisplayId.trim()
      : null;

  if (preferredDisplayId) {
    const byPreferredDisplay = sources.find(
      (source) => String(source?.display_id ?? "") === preferredDisplayId,
    );
    if (byPreferredDisplay) return byPreferredDisplay;
  }

  let screenApi: any;
  try {
    ({ screen: screenApi } = require("electron") as typeof import("electron"));
  } catch {
    return sources[0] || null;
  }

  try {
    const cursor = screenApi.getCursorScreenPoint();
    const display = screenApi.getDisplayNearestPoint(cursor);
    const displayId = String(display?.id ?? "");
    if (displayId) {
      const byCursorDisplay = sources.find(
        (source) => String(source?.display_id ?? "") === displayId,
      );
      if (byCursorDisplay) return byCursorDisplay;
    }
  } catch (err) {
    log.warn("[RewardScanner] pickScreenSource cursor lookup failed:", normalizeErrorMessage(err));
  }

  try {
    const primaryDisplay = screenApi.getPrimaryDisplay();
    const primaryId = String(primaryDisplay?.id ?? "");
    if (primaryId) {
      const byPrimaryDisplay = sources.find(
        (source) => String(source?.display_id ?? "") === primaryId,
      );
      if (byPrimaryDisplay) return byPrimaryDisplay;
    }
  } catch (err) {
    log.warn("[RewardScanner] pickScreenSource primary lookup failed:", normalizeErrorMessage(err));
  }

  return sources[0] || null;
}

export function getCaptureThumbnailSize(preferredDisplayId?: string | null): {
  width: number;
  height: number;
} {
  let screenApi: any;
  try {
    ({ screen: screenApi } = require("electron") as typeof import("electron"));
  } catch {
    return {
      width: CAPTURE_THUMBNAIL_LIMITS.minWidth,
      height: CAPTURE_THUMBNAIL_LIMITS.minHeight,
    };
  }

  try {
    const displays = screenApi.getAllDisplays?.() || [];
    const preferred =
      preferredDisplayId != null
        ? displays.find((display: any) => String(display?.id ?? "") === String(preferredDisplayId))
        : null;
    const primary = preferred || screenApi.getPrimaryDisplay();
    const width = clampNumber(
      primary?.size?.width || 0,
      CAPTURE_THUMBNAIL_LIMITS.minWidth,
      CAPTURE_THUMBNAIL_LIMITS.maxWidth,
      CAPTURE_THUMBNAIL_LIMITS.minWidth,
    );
    const height = clampNumber(
      primary?.size?.height || 0,
      CAPTURE_THUMBNAIL_LIMITS.minHeight,
      CAPTURE_THUMBNAIL_LIMITS.maxHeight,
      CAPTURE_THUMBNAIL_LIMITS.minHeight,
    );

    return {
      width: Math.floor(width),
      height: Math.floor(height),
    };
  } catch {
    return {
      width: CAPTURE_THUMBNAIL_LIMITS.minWidth,
      height: CAPTURE_THUMBNAIL_LIMITS.minHeight,
    };
  }
}

interface CaptureOptions {
  preferredDisplayId?: string | null;
  preferScreenCapture?: boolean;
}

export interface CaptureResult {
  image: any;
  sourceType: "window" | "screen";
  sourceName: string;
  sourceId: string;
  sourceDisplayId: string;
}

/**
 * Fast screen-only capture via GDI BitBlt (~15-50 ms).
 *
 * The `_dxgiTimeoutMs` parameter is accepted for API compatibility but
 * ignored — GDI always returns current screen content.
 */
export async function captureScreenFast(
  preferredDisplayId?: string | null,
  _dxgiTimeoutMs = 0,
): Promise<CaptureResult | null> {
  try {
    const gdiResult = captureGdi(preferredDisplayId || null);
    if (gdiResult) {
      const { nativeImage: electronNativeImage } =
        require("electron") as typeof import("electron");
      const img = electronNativeImage.createFromBitmap(gdiResult.buffer, {
        width: gdiResult.width,
        height: gdiResult.height,
      });
      if (img && !img.isEmpty()) {
        return {
          image: img,
          sourceType: "screen",
          sourceName: "GDI BitBlt",
          sourceId: `gdi:${gdiResult.displayId || "0"}`,
          sourceDisplayId: gdiResult.displayId || "",
        };
      }
    }
  } catch (err) {
    log.warn("[RewardScanner] GDI capture failed:", normalizeErrorMessage(err));
  }

  return null;
}

export async function captureScreen(options: CaptureOptions = {}): Promise<CaptureResult | null> {
  return captureScreenFast(options.preferredDisplayId || null);
}

export async function captureDebugFrame(options: CaptureOptions = {}): Promise<{
  imageDataUrl: string;
  width: number;
  height: number;
  sourceLabel: string;
} | null> {
  const screenshot = await captureScreen(options);
  if (!screenshot) return null;
  const size = screenshot.image.getSize();

  const sourceLabel =
    screenshot.sourceType === "window"
      ? `window: ${screenshot.sourceName || screenshot.sourceId || "unknown"}`
      : `screen: ${screenshot.sourceName || screenshot.sourceDisplayId || screenshot.sourceId || "unknown"}`;

  log.log(`[RewardScanner] Debug capture source -> ${sourceLabel}`);

  return {
    imageDataUrl: screenshot.image.toDataURL(),
    width: size.width,
    height: size.height,
    sourceLabel,
  };
}

export async function captureSourceMeta(options: CaptureOptions = {}): Promise<{
  sourceType: string | null;
  sourceName: string | null;
  sourceId: string | null;
  sourceDisplayId: string | null;
} | null> {
  const screenshot = await captureScreen(options);
  if (!screenshot) return null;

  return {
    sourceType: screenshot.sourceType || null,
    sourceName: screenshot.sourceName || null,
    sourceId: screenshot.sourceId || null,
    sourceDisplayId: screenshot.sourceDisplayId || null,
  };
}