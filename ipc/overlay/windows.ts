"use strict";

import path from "node:path";

export {};

const OVERLAY_WINDOW_BOUNDS = Object.freeze({
  width: 980,
  height: 220,
  horizontalMargin: 16,
  bottomMargin: 18,
  topMargin: 8,
  defaultYRatio: 0.47,
  anchorGapRatio: 0.018,
  anchorMinRatio: 0.22,
  anchorMaxRatio: 0.82,
});

type OverlayAnchorMeta = {
  sourceDisplayId?: string | null;
  bandBottomRatio?: number;
};

type OverlayContext = {
  overlayWindow: import("electron").BrowserWindow | null;
  cropDebugWindow: import("electron").BrowserWindow | null;
  overlaySettings: Record<string, unknown>;
};

type OverlayWindowsControllerOptions = {
  app: typeof import("electron").app;
  BrowserWindow: typeof import("electron").BrowserWindow;
  screen: typeof import("electron").screen;
  ctx: OverlayContext;
  log: { warn: (...args: unknown[]) => void };
  hardenBrowserWindowNavigation: (
    browserWindow: import("electron").BrowserWindow,
    options: {
      label: string;
      allowedFilePaths: string[];
      log: { warn: (...args: unknown[]) => void };
    },
  ) => void;
  overlayWindowFile: string;
  cropDebugWindowFile: string;
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function createOverlayWindowsController(options: OverlayWindowsControllerOptions) {
  const {
    app,
    BrowserWindow,
    screen,
    ctx,
    log,
    hardenBrowserWindowNavigation,
    overlayWindowFile,
    cropDebugWindowFile,
  } = options;

  let lastOverlayAnchorMeta: OverlayAnchorMeta | null = null;
  let overlayAutoHideTimer: ReturnType<typeof setTimeout> | null = null;

  function getElectronBuildFile(fileName: string): string {
    return path.join(app.getAppPath(), ".electron-build", fileName);
  }

  function findDisplayById(displayId: unknown): import("electron").Display | null {
    if (!displayId) return null;
    const wanted = String(displayId);
    return screen.getAllDisplays().find((display) => String(display.id) === wanted) || null;
  }

  function getDisplayForOverlay(anchorMeta: OverlayAnchorMeta | null): import("electron").Display {
    const metaDisplayId =
      anchorMeta && typeof anchorMeta === "object" ? anchorMeta.sourceDisplayId : null;

    const byMeta = findDisplayById(metaDisplayId);
    if (byMeta) return byMeta;

    try {
      const point = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point);
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  function getAnchorRatio(anchorMeta: OverlayAnchorMeta | null): number {
    if (!anchorMeta || typeof anchorMeta !== "object") {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    const bandBottom = Number(anchorMeta.bandBottomRatio);
    if (!Number.isFinite(bandBottom)) {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    const anchoredRatio = bandBottom + OVERLAY_WINDOW_BOUNDS.anchorGapRatio;
    return clampNumber(
      anchoredRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
      OVERLAY_WINDOW_BOUNDS.defaultYRatio,
    );
  }

  function getOverlayBoundsForActiveDisplay(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ) {
    const display = getDisplayForOverlay(anchorMeta);
    const area = display?.workArea || {
      x: 0,
      y: 0,
      width: OVERLAY_WINDOW_BOUNDS.width,
      height: OVERLAY_WINDOW_BOUNDS.height,
    };

    const maxAllowedWidth = Math.max(760, area.width - OVERLAY_WINDOW_BOUNDS.horizontalMargin * 2);
    const width = Math.min(OVERLAY_WINDOW_BOUNDS.width, maxAllowedWidth);
    const height = Math.min(OVERLAY_WINDOW_BOUNDS.height, Math.max(160, area.height - 20));

    const x = Math.round(area.x + (area.width - width) / 2);
    const preferredY = Math.round(area.y + area.height * getAnchorRatio(anchorMeta));
    const maxY = area.y + area.height - height - OVERLAY_WINDOW_BOUNDS.bottomMargin;
    const minY = area.y + OVERLAY_WINDOW_BOUNDS.topMargin;
    const y = Math.max(minY, Math.min(maxY, preferredY));

    return { x, y, width, height };
  }

  function positionOverlayWindow(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ): void {
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
    const bounds = getOverlayBoundsForActiveDisplay(anchorMeta);
    ctx.overlayWindow.setBounds(bounds, false);
  }

  function createOverlayWindow(): void {
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      positionOverlayWindow(lastOverlayAnchorMeta);
      ctx.overlayWindow.show();
      ctx.overlayWindow.focus();
      return;
    }

    const initialBounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);

    ctx.overlayWindow = new BrowserWindow({
      width: initialBounds.width,
      height: initialBounds.height,
      x: initialBounds.x,
      y: initialBounds.y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: getElectronBuildFile("preload-overlay.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    hardenBrowserWindowNavigation(ctx.overlayWindow, {
      label: "overlay window",
      allowedFilePaths: [overlayWindowFile],
      log,
    });

    void ctx.overlayWindow.loadFile(overlayWindowFile);
    ctx.overlayWindow.setAlwaysOnTop(true, "screen-saver");
    positionOverlayWindow(lastOverlayAnchorMeta);
    ctx.overlayWindow.on("closed", () => {
      clearOverlayAutoHideTimer();
      ctx.overlayWindow = null;
    });
  }

  function createCropDebugWindow(frame: Record<string, unknown>): void {
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.show();
      ctx.cropDebugWindow.focus();
      ctx.cropDebugWindow.webContents.send("crop-debug:init", {
        ...frame,
        cropTopRatio: ctx.overlaySettings.cropTopRatio,
        cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
      });
      return;
    }

    ctx.cropDebugWindow = new BrowserWindow({
      width: 1200,
      height: 760,
      minWidth: 900,
      minHeight: 600,
      autoHideMenuBar: true,
      title: "OCR Crop Debugger",
      backgroundColor: "#0b1320",
      webPreferences: {
        preload: getElectronBuildFile("preload-crop.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    hardenBrowserWindowNavigation(ctx.cropDebugWindow, {
      label: "crop debug window",
      allowedFilePaths: [cropDebugWindowFile],
      log,
    });

    void ctx.cropDebugWindow.loadFile(cropDebugWindowFile);

    ctx.cropDebugWindow.webContents.once("did-finish-load", () => {
      if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
        ctx.cropDebugWindow.webContents.send("crop-debug:init", {
          ...frame,
          cropTopRatio: ctx.overlaySettings.cropTopRatio,
          cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
        });
      }
    });

    ctx.cropDebugWindow.on("closed", () => {
      ctx.cropDebugWindow = null;
    });
  }

  function clearOverlayAutoHideTimer(): void {
    if (!overlayAutoHideTimer) return;
    clearTimeout(overlayAutoHideTimer);
    overlayAutoHideTimer = null;
  }

  function scheduleOverlayAutoHide(delayMs: number): void {
    clearOverlayAutoHideTimer();

    const delay = Math.max(250, Math.floor(Number(delayMs) || 0));
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

    overlayAutoHideTimer = setTimeout(() => {
      overlayAutoHideTimer = null;
      if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
      if (ctx.overlayWindow.isVisible()) {
        ctx.overlayWindow.hide();
      }
    }, delay);
  }

  function sendOverlayEvent(channel: string, payload?: unknown): void {
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

    const targetWindow = ctx.overlayWindow;
    const sendNow = () => {
      if (!targetWindow || targetWindow.isDestroyed()) return;
      targetWindow.webContents.send(channel, payload);
    };

    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", sendNow);
      return;
    }

    sendNow();
  }

  function setAnchorMeta(anchorMeta: OverlayAnchorMeta | null): void {
    lastOverlayAnchorMeta = anchorMeta || null;
  }

  function getAnchorMeta(): OverlayAnchorMeta | null {
    return lastOverlayAnchorMeta;
  }

  return {
    getOverlayBoundsForActiveDisplay,
    positionOverlayWindow,
    createOverlayWindow,
    createCropDebugWindow,
    clearOverlayAutoHideTimer,
    scheduleOverlayAutoHide,
    sendOverlayEvent,
    setAnchorMeta,
    getAnchorMeta,
  };
}

module.exports = {
  createOverlayWindowsController,
};
