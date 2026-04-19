/**
 * Screen capture helpers for reward and riven scanning.
 * Uses GDI BitBlt via koffi as the sole capture method.
 */

import { withScope } from "./logger";
import { captureGdi } from "./dxgiCapture";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("rewardScanner");

interface CaptureOptions {
  preferredDisplayId?: string | null;
  preferScreenCapture?: boolean;
}

import type { NativeImage } from "electron";

export interface CaptureResult {
  image: NativeImage;
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
