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
 * Non-Windows capture via Electron desktopCapturer. Slower than GDI but
 * portable (X11 direct; Wayland goes through the desktop portal, which may
 * prompt the user once per session).
 */
async function captureDesktopCapturer(
  preferredDisplayId?: string | null,
): Promise<CaptureResult | null> {
  try {
    const { desktopCapturer, screen } = require("electron") as typeof import("electron");
    const displays = screen.getAllDisplays();
    const wanted = preferredDisplayId?.trim() || null;
    const target =
      (wanted && displays.find((d) => String(d.id) === wanted)) || screen.getPrimaryDisplay();
    const scale = target.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(target.size.width * scale),
        height: Math.round(target.size.height * scale),
      },
    });
    const source = sources.find((s) => s.display_id === String(target.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    return {
      image: source.thumbnail,
      sourceType: "screen",
      sourceName: source.name || "desktopCapturer",
      sourceId: source.id,
      sourceDisplayId: source.display_id || String(target.id),
    };
  } catch (err) {
    log.warn("[RewardScanner] desktopCapturer capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

/**
 * Fast screen-only capture: GDI BitBlt on Windows (~15-50 ms), Electron
 * desktopCapturer elsewhere.
 *
 * The `_dxgiTimeoutMs` parameter is accepted for API compatibility but
 * ignored - GDI always returns current screen content.
 */
export async function captureScreenFast(
  preferredDisplayId?: string | null,
  _dxgiTimeoutMs = 0,
): Promise<CaptureResult | null> {
  if (process.platform !== "win32") {
    return captureDesktopCapturer(preferredDisplayId);
  }
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
