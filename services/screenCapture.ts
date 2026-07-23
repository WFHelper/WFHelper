// Platform-dispatched screen capture for reward/riven scanning.
// win32: GDI BitBlt via koffi (~15-50 ms), cropped to the Warframe client rect.
// elsewhere: Electron desktopCapturer full-screen (X11 direct; Wayland goes
// through the PipeWire portal and may prompt once), trimmed to the letterboxed
// game content rect since no native window rect exists off-Windows.

import type { NativeImage } from "electron";
import { withScope } from "./logger";
import { captureGdi, getGameWindowClientRect } from "./dxgiCapture";
import { detectGameContentRect } from "./rewardScannerImage";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("screenCapture");

export interface CaptureResult {
  image: NativeImage;
  sourceType: "window" | "screen";
  sourceName: string;
  sourceId: string;
  sourceDisplayId: string;
}

interface CaptureOptions {
  preferredDisplayId?: string | null;
}

async function captureWin32Gdi(preferredDisplayId?: string | null): Promise<CaptureResult | null> {
  const gdiResult = captureGdi(preferredDisplayId || null);
  if (!gdiResult) return null;
  // dynamic import keeps electron lazy and lets tests mock it
  const { nativeImage } = await import("electron");
  let img = nativeImage.createFromBitmap(gdiResult.buffer, {
    width: gdiResult.width,
    height: gdiResult.height,
  });
  if (!img || img.isEmpty()) return null;
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
          `[ScreenCapture] cropped to Warframe client rect ${width}x${height} at (${x},${y})`,
        );
      }
    }
  } catch (err) {
    log.warn("[ScreenCapture] game window crop skipped:", normalizeErrorMessage(err));
  }
  return {
    image: img,
    sourceType: "screen",
    sourceName: "GDI BitBlt",
    sourceId: `gdi:${gdiResult.displayId || "0"}`,
    sourceDisplayId: gdiResult.displayId || "",
  };
}

// Off-Windows stand-in for the client-rect crop: trim letterbox/pillarbox bars
// so crop ratios anchor to game content. Windowed mode stays best-effort.
function trimToGameContent(img: NativeImage): NativeImage {
  try {
    const size = img.getSize();
    const content = detectGameContentRect(img);
    const isSubRegion = content.width < size.width - 2 || content.height < size.height - 2;
    if (isSubRegion && content.width >= 320 && content.height >= 240) {
      log.info(
        `[ScreenCapture] trimmed letterbox to ${content.width}x${content.height} at (${content.x},${content.y})`,
      );
      return img.crop(content);
    }
  } catch (err) {
    log.warn("[ScreenCapture] content trim skipped:", normalizeErrorMessage(err));
  }
  return img;
}

async function captureDesktopCapturer(
  preferredDisplayId?: string | null,
): Promise<CaptureResult | null> {
  try {
    const { desktopCapturer, screen } = await import("electron");
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
      image: trimToGameContent(source.thumbnail),
      sourceType: "screen",
      sourceName: source.name || "desktopCapturer",
      sourceId: source.id,
      sourceDisplayId: source.display_id || String(target.id),
    };
  } catch (err) {
    log.warn("[ScreenCapture] desktopCapturer capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

// Sole platform dispatch point. On win32 a GDI failure returns null rather
// than falling back to desktopCapturer, which can serve stale MPO content.
// _captureTimeoutMs kept for API compatibility; both backends return current content.
export async function captureScreenFast(
  preferredDisplayId?: string | null,
  _captureTimeoutMs = 0,
): Promise<CaptureResult | null> {
  if (process.platform !== "win32") {
    return captureDesktopCapturer(preferredDisplayId);
  }
  try {
    return await captureWin32Gdi(preferredDisplayId);
  } catch (err) {
    log.warn("[ScreenCapture] GDI capture failed:", normalizeErrorMessage(err));
    return null;
  }
}

export async function captureSourceMeta(options: CaptureOptions = {}): Promise<{
  sourceType: string | null;
  sourceName: string | null;
  sourceId: string | null;
  sourceDisplayId: string | null;
} | null> {
  const screenshot = await captureScreenFast(options.preferredDisplayId || null);
  if (!screenshot) return null;

  return {
    sourceType: screenshot.sourceType || null,
    sourceName: screenshot.sourceName || null,
    sourceId: screenshot.sourceId || null,
    sourceDisplayId: screenshot.sourceDisplayId || null,
  };
}
