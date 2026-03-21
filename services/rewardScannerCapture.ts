"use strict";

/**
 * Electron screen / window capture helpers for reward scanning.
 * Isolates all `require("electron")` calls for desktopCapturer and screen.
 */

import { withScope } from "./logger";
import { clampNumber } from "./rewardScannerUtils";
import { captureDxgi, isDxgiAvailable } from "./dxgiCapture";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

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

interface CaptureResult {
  image: any;
  sourceType: "window" | "screen";
  sourceName: string;
  sourceId: string;
  sourceDisplayId: string;
}

export async function captureScreen(options: CaptureOptions = {}): Promise<CaptureResult | null> {
  let desktopCapturer: any;
  try {
    ({ desktopCapturer } = require("electron") as typeof import("electron"));
  } catch {
    log.warn("[RewardScanner] electron.desktopCapturer unavailable");
    return null;
  }

  let sources: any[];
  const thumbnailSize = getCaptureThumbnailSize(options.preferredDisplayId || null);

  // When the caller wants a screen source, skip the window getSources call entirely.
  // It would be discarded anyway and costs ~300-600 ms per call.
  if (options?.preferScreenCapture !== true) {
    try {
      sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize,
        fetchWindowIcons: false,
      });
    } catch (err) {
      log.warn("[RewardScanner] getSources(window) failed:", normalizeErrorMessage(err));
      sources = [];
    }

    const wfWindow = pickWindowSource(sources);
    const skipWindowCapture = isLikelyWrongWindowName(sourceName(wfWindow || null));
    if (!skipWindowCapture && wfWindow && wfWindow.thumbnail && !wfWindow.thumbnail.isEmpty()) {
      return {
        image: wfWindow.thumbnail,
        sourceType: "window",
        sourceName: sourceName(wfWindow),
        sourceId: String(wfWindow.id || ""),
        sourceDisplayId: String(wfWindow.display_id || ""),
      };
    }
  }

  // Try DXGI Desktop Duplication first — ~2-10 ms vs ~100-300 ms with
  // desktopCapturer.getSources. Falls back transparently on failure.
  if (isDxgiAvailable()) {
    try {
      const dxgiResult = captureDxgi();
      if (dxgiResult) {
        const { nativeImage: electronNativeImage } = require("electron") as typeof import("electron");
        const img = electronNativeImage.createFromBitmap(dxgiResult.buffer, {
          width: dxgiResult.width,
          height: dxgiResult.height,
        });
        if (img && !img.isEmpty()) {
          return {
            image: img,
            sourceType: "screen",
            sourceName: "DXGI Desktop Duplication",
            sourceId: "dxgi:0",
            sourceDisplayId: "",
          };
        }
      }
    } catch (err) {
      log.warn("[RewardScanner] DXGI capture failed, falling back:", normalizeErrorMessage(err));
    }
  }

  try {
    const screens = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize,
    });

    const pickedScreen = pickScreenSource(screens, options);
    if (pickedScreen && pickedScreen.thumbnail && !pickedScreen.thumbnail.isEmpty()) {
      return {
        image: pickedScreen.thumbnail,
        sourceType: "screen",
        sourceName: sourceName(pickedScreen),
        sourceId: String(pickedScreen.id || ""),
        sourceDisplayId: String(pickedScreen.display_id || ""),
      };
    }
  } catch (err) {
    log.warn("[RewardScanner] getSources(screen) failed:", normalizeErrorMessage(err));
  }

  return null;
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
