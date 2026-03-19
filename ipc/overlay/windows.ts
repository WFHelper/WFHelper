"use strict";

import path from "node:path";
import { createRuntimeRequire } from "../runtimeRequire";


const requireRuntime = createRuntimeRequire(__dirname, 2);
const { clampNumber } = requireRuntime<{
  clampNumber: (value: unknown, min: number, max: number, fallback: number) => number;
}>("config/shared/numeric.cjs");

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
  overlayInteractiveMode: boolean;
};

type OverlayWindowsControllerOptions = {
  app: typeof import("electron").app;
  BrowserWindow: typeof import("electron").BrowserWindow;
  screen: typeof import("electron").screen;
  ctx: OverlayContext;
  getOverlayWindow?: () => import("electron").BrowserWindow | null;
  setOverlayWindow?: (window: import("electron").BrowserWindow | null) => void;
  getOverlayInteractiveMode?: () => boolean;
  setOverlayInteractiveModeState?: (enabled: boolean) => void;
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
  placement?: "center" | "top-left" | "top-right";
  windowWidth?: number;
  windowHeight?: number;
  minWindowWidth?: number;
  minWindowHeight?: number;
  /** When false the window gets a solid background (default: true = transparent). */
  transparent?: boolean;
  /** Background colour used when transparent=false (default: '#060a12'). */
  backgroundColor?: string;
};

export function createOverlayWindowsController(options: OverlayWindowsControllerOptions) {
  const {
    app,
    BrowserWindow,
    screen,
    ctx,
    getOverlayWindow,
    setOverlayWindow,
    getOverlayInteractiveMode,
    setOverlayInteractiveModeState,
    log,
    hardenBrowserWindowNavigation,
    overlayWindowFile,
    cropDebugWindowFile,
    placement = "center",
    windowWidth = OVERLAY_WINDOW_BOUNDS.width,
    windowHeight = OVERLAY_WINDOW_BOUNDS.height,
    minWindowWidth = 760,
    minWindowHeight = 160,
    transparent = true,
    backgroundColor = "#060a12",
  } = options;

  let lastOverlayAnchorMeta: OverlayAnchorMeta | null = null;
  let overlayAutoHideTimer: ReturnType<typeof setTimeout> | null = null;

  const readOverlayWindow =
    getOverlayWindow ||
    (() => {
      return ctx.overlayWindow;
    });

  const writeOverlayWindow =
    setOverlayWindow ||
    ((window: import("electron").BrowserWindow | null) => {
      ctx.overlayWindow = window;
    });

  const readInteractiveMode =
    getOverlayInteractiveMode ||
    (() => {
      return ctx.overlayInteractiveMode;
    });

  const writeInteractiveMode =
    setOverlayInteractiveModeState ||
    ((enabled: boolean) => {
      ctx.overlayInteractiveMode = !!enabled;
    });

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

  function computeOverlayZoomFactor(display: import("electron").Display): number {
    const h = display.workArea.height;
    if (h <= 720) return 0.8;
    if (h <= 900) return 0.9;
    if (h <= 1200) return 1.0;
    if (h <= 1600) return 1.15;
    return 1.3;
  }

  function getOverlayBoundsForActiveDisplay(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ) {
    const display = getDisplayForOverlay(anchorMeta);
    const zoomFactor = computeOverlayZoomFactor(display);
    const scaledWidth = Math.round(windowWidth * zoomFactor);
    const scaledHeight = Math.round(windowHeight * zoomFactor);
    const area = display?.workArea || {
      x: 0,
      y: 0,
      width: scaledWidth,
      height: scaledHeight,
    };

    const maxAllowedWidth = Math.max(
      minWindowWidth,
      area.width - OVERLAY_WINDOW_BOUNDS.horizontalMargin * 2,
    );
    const width = Math.min(scaledWidth, maxAllowedWidth);
    const height = Math.min(scaledHeight, Math.max(minWindowHeight, area.height - 20));

    const minX = area.x + OVERLAY_WINDOW_BOUNDS.horizontalMargin;
    const maxX = area.x + area.width - width - OVERLAY_WINDOW_BOUNDS.horizontalMargin;
    const minY = area.y + OVERLAY_WINDOW_BOUNDS.topMargin;
    const maxY = area.y + area.height - height - OVERLAY_WINDOW_BOUNDS.bottomMargin;

    let x = Math.round(area.x + (area.width - width) / 2);
    let y = Math.round(area.y + area.height * getAnchorRatio(anchorMeta));

    if (placement === "top-left") {
      x = minX;
      y = minY;
    } else if (placement === "top-right") {
      x = maxX;
      y = minY;
    }

    x = Math.max(minX, Math.min(maxX, x));
    y = Math.max(minY, Math.min(maxY, y));

    return { x, y, width, height, zoomFactor };
  }

  function positionOverlayWindow(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const { zoomFactor, ...rect } = getOverlayBoundsForActiveDisplay(anchorMeta);
    overlayWindow.setBounds(rect, false);
    overlayWindow.webContents.setZoomFactor(zoomFactor);
  }

  function createOverlayWindow(options: { show?: boolean } = {}): void {
    const shouldShow = options.show !== false;
    const existingWindow = readOverlayWindow();
    if (existingWindow && !existingWindow.isDestroyed()) {
      positionOverlayWindow(lastOverlayAnchorMeta);
      existingWindow.setAlwaysOnTop(true, "screen-saver");
      if (shouldShow) {
        existingWindow.showInactive();
        // moveTop + alwaysOnTop confirmed AFTER showInactive so the window
        // is definitely in the visible stack before we raise it.
        existingWindow.moveTop();
        existingWindow.setAlwaysOnTop(true, "screen-saver");
        const bounds = existingWindow.getBounds();
        const visible = existingWindow.isVisible();
        log.warn(
          `[OverlayWindow] shown existing window visible=${visible} bounds=${JSON.stringify(bounds)}`,
        );
      }
      setOverlayInteractiveMode(readInteractiveMode());
      return;
    }

    const initialBounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);

    const createdWindow = new BrowserWindow({
      width: initialBounds.width,
      height: initialBounds.height,
      x: initialBounds.x,
      y: initialBounds.y,
      show: false,
      transparent,
      backgroundColor: transparent ? undefined : backgroundColor,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true,
      webPreferences: {
        preload: getElectronBuildFile("preload-overlay.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    writeOverlayWindow(createdWindow);

    hardenBrowserWindowNavigation(createdWindow, {
      label: "overlay window",
      allowedFilePaths: [overlayWindowFile],
      log,
    });

    void createdWindow.loadFile(overlayWindowFile);
    createdWindow.setAlwaysOnTop(true, "screen-saver");
    createdWindow.moveTop();
    createdWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    setOverlayInteractiveMode(readInteractiveMode());
    positionOverlayWindow(lastOverlayAnchorMeta);
    if (shouldShow) {
      createdWindow.showInactive();
    }
    createdWindow.on("closed", () => {
      clearOverlayAutoHideTimer();
      writeOverlayWindow(null);
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
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    overlayAutoHideTimer = setTimeout(() => {
      overlayAutoHideTimer = null;
      const activeWindow = readOverlayWindow();
      if (!activeWindow || activeWindow.isDestroyed()) return;
      if (activeWindow.isVisible()) {
        activeWindow.hide();
      }
    }, delay);
  }

  function sendOverlayEvent(channel: string, payload?: unknown): void {
    const targetWindow = readOverlayWindow();
    if (!targetWindow || targetWindow.isDestroyed()) return;
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

  function setOverlayInteractiveMode(enabled: boolean): void {
    writeInteractiveMode(!!enabled);
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const isVisible = overlayWindow.isVisible();

    if (!isVisible) return;

    if (readInteractiveMode()) {
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.setFocusable(true);
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.moveTop();
      overlayWindow.focus();
    } else {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.setFocusable(true);
      overlayWindow.blur();
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.moveTop();
      overlayWindow.showInactive();
    }
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
    setOverlayInteractiveMode,
  };
}
