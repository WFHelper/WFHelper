/**
 * Screen capture helpers for reward and riven scanning.
 * Uses GDI BitBlt via koffi as the sole capture method.
 */

import { withScope } from "./logger";
import { captureGdi, getGameWindowClientRect } from "./dxgiCapture";
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
 * ignored - GDI always returns current screen content.
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
      let img = electronNativeImage.createFromBitmap(gdiResult.buffer, {
        width: gdiResult.width,
        height: gdiResult.height,
      });
      if (img && !img.isEmpty()) {
        // Windowed game: crop the monitor capture to the game's client rect so
        // layout ratios anchor to game content, not desktop + window chrome.
        // Borderless/fullscreen client rect equals the monitor -> no crop.
        try {
          const gameRect = getGameWindowClientRect();
          if (gameRect) {
            const ox = gameRect.x - gdiResult.originX;
            const oy = gameRect.y - gdiResult.originY;
            const x = Math.max(0, ox);
            const y = Math.max(0, oy);
            const width = Math.min(gdiResult.width, ox + gameRect.width) - x;
            const height = Math.min(gdiResult.height, oy + gameRect.height) - y;
            const isSubRegion = width < gdiResult.width - 2 || height < gdiResult.height - 2;
            if (isSubRegion && width >= 320 && height >= 240) {
              img = img.crop({ x, y, width, height });
              log.info(
                `[RewardScanner] Cropped capture to Warframe client rect ${width}x${height} at (${x},${y})`,
              );
            }
          }
        } catch (err) {
          log.warn("[RewardScanner] game window crop skipped:", normalizeErrorMessage(err));
        }
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

async function captureScreen(options: CaptureOptions = {}): Promise<CaptureResult | null> {
  return captureScreenFast(options.preferredDisplayId || null);
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
