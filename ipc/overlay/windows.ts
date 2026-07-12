import path from "node:path";
import { clampNumber } from "../../config/shared/numeric";
import type {
  OverlaySavedWindowBounds,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings";

const OVERLAY_WINDOW_BOUNDS = Object.freeze({
  width: 980,
  height: 140,
  horizontalMargin: 16,
  bottomMargin: 18,
  topMargin: 8,
  defaultYRatio: 0.56,
  anchorGapRatio: 0.04,
  anchorMinRatio: 0.32,
  anchorMaxRatio: 0.82,
});

type OverlayAnchorMeta = {
  sourceDisplayId?: string | null;
  bandTopRatio?: number | null;
  bandBottomRatio?: number | null;
};

type OverlayContext = {
  overlayWindow: import("electron").BrowserWindow | null;
  overlaySettings: import("../../config/runtime/overlaySettings").OverlaySettings;
  overlayInteractiveMode: boolean;
};

type OverlaySettingsPersistenceOptions = {
  ctx: Pick<OverlayContext, "overlaySettings">;
  save: () => void;
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
  windowLabel?: string;
  preloadFileName?: string;
  fileSearch?: string;
  placement?: "center" | "top-left" | "top-right";
  displayMode?: "cursor" | "primary";
  topOffset?: number;
  windowWidth?: number;
  windowHeight?: number;
  minWindowWidth?: number;
  minWindowHeight?: number;
  hasShadow?: boolean;
  ignoreMouseEventsForward?: boolean;
  /** When false the window gets a solid background (default: true = transparent). */
  transparent?: boolean;
  /** Background colour used when transparent=false (default: '#060a12'). */
  backgroundColor?: string;
  windowStateKey?: OverlayWindowKey;
  onWindowBoundsChanged?: (
    key: OverlayWindowKey,
    bounds: OverlaySavedWindowBounds,
  ) => void;
  /** Persist user moves even when the interactive-mode getter reports false
   * (arbi summary: always draggable but never factory-interactive). */
  persistBoundsWhenPassive?: boolean;
};

export function createOverlayWindowBoundsChangeHandler(
  options: OverlaySettingsPersistenceOptions,
): (key: OverlayWindowKey, bounds: OverlaySavedWindowBounds) => void {
  return (key, bounds) => {
    options.ctx.overlaySettings = {
      ...options.ctx.overlaySettings,
      // A live drag proves the user knows the move mechanic - retire the hint
      // chip. The arbi summary is draggable without the unlock hotkey, so it
      // doesn't count as having learned it.
      ...(key === "arbiSummary" ? {} : { overlayDragHintDismissed: true }),
      overlayWindowBounds: {
        ...(options.ctx.overlaySettings.overlayWindowBounds || {}),
        [key]: bounds,
      },
    };
    options.save();
  };
}

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
    windowLabel = "overlay window",
    preloadFileName = "preload-overlay.js",
    fileSearch,
    placement = "center",
    displayMode = "cursor",
    topOffset = OVERLAY_WINDOW_BOUNDS.topMargin,
    windowWidth = OVERLAY_WINDOW_BOUNDS.width,
    windowHeight = OVERLAY_WINDOW_BOUNDS.height,
    minWindowWidth = 760,
    minWindowHeight = 160,
    hasShadow,
    ignoreMouseEventsForward = true,
    transparent = true,
    backgroundColor = "#060a12",
    windowStateKey,
    onWindowBoundsChanged,
    persistBoundsWhenPassive = false,
  } = options;

  let lastOverlayAnchorMeta: OverlayAnchorMeta | null = null;
  let overlayAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressMoveSave = false;
  let moveSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let rendererReady = false;
  const pendingOverlayEvents: Array<{ channel: string; payload?: unknown }> = [];

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

  function readSavedBounds(): OverlaySavedWindowBounds | null {
    if (!windowStateKey) return null;
    const saved = ctx.overlaySettings?.overlayWindowBounds?.[windowStateKey];
    if (!saved || typeof saved !== "object") return null;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    return saved;
  }

  function getDisplayForOverlay(anchorMeta: OverlayAnchorMeta | null): import("electron").Display {
    if (displayMode === "primary") {
      return screen.getPrimaryDisplay();
    }

    const metaDisplayId =
      anchorMeta && typeof anchorMeta === "object" ? anchorMeta.sourceDisplayId : null;

    const byMeta = findDisplayById(metaDisplayId);
    if (byMeta) return byMeta;

    try {
      const point = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point);
    } catch {
      // Cursor position unavailable (e.g. headless/locked session) - fall back to primary.
      return screen.getPrimaryDisplay();
    }
  }

  function getAnchorRatio(anchorMeta: OverlayAnchorMeta | null): number {
    if (!anchorMeta || typeof anchorMeta !== "object") {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    const bandBottom =
      typeof anchorMeta.bandBottomRatio === "number" && Number.isFinite(anchorMeta.bandBottomRatio)
        ? anchorMeta.bandBottomRatio
        : null;
    if (bandBottom != null) {
      const anchoredRatio = bandBottom + OVERLAY_WINDOW_BOUNDS.anchorGapRatio;
      return clampNumber(
        anchoredRatio,
        OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
        OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
        OVERLAY_WINDOW_BOUNDS.defaultYRatio,
      );
    }

    const bandTop =
      typeof anchorMeta.bandTopRatio === "number" && Number.isFinite(anchorMeta.bandTopRatio)
        ? anchorMeta.bandTopRatio
        : null;
    if (bandTop == null) {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    return clampNumber(
      bandTop + OVERLAY_WINDOW_BOUNDS.anchorGapRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
      OVERLAY_WINDOW_BOUNDS.defaultYRatio,
    );
  }

  function computeOverlayZoomFactor(display: import("electron").Display): number {
    const h = display.workArea.height;
    let base = 1.3;
    if (h <= 720) base = 0.8;
    else if (h <= 900) base = 0.9;
    else if (h <= 1200) base = 1.0;
    else if (h <= 1600) base = 1.15;
    const perWindow = windowStateKey
      ? (ctx.overlaySettings?.overlayWindowScales || {})[windowStateKey]
      : undefined;
    const userScale = clampNumber(
      perWindow ?? ctx.overlaySettings?.overlayScale,
      0.75,
      1.5,
      1,
    );
    return Number((base * userScale).toFixed(3));
  }

  function getOverlayBoundsForActiveDisplay(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ) {
    const savedBounds = readSavedBounds();
    const display =
      (savedBounds ? findDisplayById(savedBounds.displayId) : null) ||
      getDisplayForOverlay(anchorMeta);
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

    if (savedBounds) {
      x = savedBounds.x;
      y = savedBounds.y;
    } else if (placement === "top-left") {
      x = minX;
      y = area.y + Math.max(0, topOffset);
    } else if (placement === "top-right") {
      x = maxX;
      y = area.y + Math.max(0, topOffset);
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
    suppressMoveSave = true;
    overlayWindow.setBounds(rect, false);
    overlayWindow.webContents.setZoomFactor(zoomFactor);
    setTimeout(() => {
      suppressMoveSave = false;
    }, 0);
  }

  function saveCurrentWindowBounds(overlayWindow: import("electron").BrowserWindow): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    if (suppressMoveSave || overlayWindow.isDestroyed()) return;
    if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
    const bounds = overlayWindow.getBounds();
    let displayId: string | null = null;
    try {
      const display = screen.getDisplayMatching(bounds);
      displayId = display ? String(display.id) : null;
    } catch {
      // No display matched the bounds - persist without a displayId.
    }
    onWindowBoundsChanged(windowStateKey, {
      x: bounds.x,
      y: bounds.y,
      ...(displayId ? { displayId } : {}),
    });
  }

  function attachBoundsPersistence(overlayWindow: import("electron").BrowserWindow): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    overlayWindow.on("move", () => {
      if (moveSaveTimer) clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(() => {
        moveSaveTimer = null;
        saveCurrentWindowBounds(overlayWindow);
      }, 250);
    });
  }

  function keepOverlayAboveGame(overlayWindow: import("electron").BrowserWindow): void {
    overlayWindow.setSkipTaskbar(true);
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  }

  function isWebContentsCrashed(webContents: import("electron").WebContents): boolean {
    return webContents.isCrashed();
  }

  function destroyIfRendererCrashed(
    overlayWindow: import("electron").BrowserWindow | null,
  ): boolean {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    if (!isWebContentsCrashed(overlayWindow.webContents)) return false;
    log.warn(`[OverlayWindow] rebuilding ${windowLabel}; renderer process was crashed`);
    overlayWindow.destroy();
    rendererReady = false;
    pendingOverlayEvents.length = 0;
    return true;
  }

  function attachRendererDiagnostics(overlayWindow: import("electron").BrowserWindow): void {
    overlayWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
      log.warn(
        `[OverlayWindow] ${windowLabel} failed to load ${url}: ${code} ${description}`,
      );
    });
    overlayWindow.webContents.on("render-process-gone", (_event, details) => {
      rendererReady = false;
      pendingOverlayEvents.length = 0;
      log.warn(
        `[OverlayWindow] ${windowLabel} renderer gone reason=${details.reason} exitCode=${details.exitCode}`,
      );
      if (!overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
    });
    overlayWindow.webContents.on("console-message", (event) => {
      if (event.level !== "warning" && event.level !== "error") return;
      log.warn(`[OverlayWindow] ${windowLabel} console: ${event.message}`);
    });
  }

  function createOverlayWindow(options: { show?: boolean } = {}): void {
    const shouldShow = options.show !== false;
    let existingWindow = readOverlayWindow();
    if (destroyIfRendererCrashed(existingWindow)) {
      existingWindow = null;
    }
    // Transparent windows can re-show as a black box after hide() on Windows,
    // so those are rebuilt. Opaque windows re-show instantly - rebuilding them
    // costs a full renderer load (the overlay appears seconds late).
    if (
      transparent &&
      shouldShow &&
      existingWindow &&
      !existingWindow.isDestroyed() &&
      !existingWindow.isVisible()
    ) {
      existingWindow.destroy();
      existingWindow = null;
      rendererReady = false;
      pendingOverlayEvents.length = 0;
    }

    if (existingWindow && !existingWindow.isDestroyed()) {
      positionOverlayWindow(lastOverlayAnchorMeta);
      keepOverlayAboveGame(existingWindow);
      if (shouldShow) {
        existingWindow.showInactive();
        // moveTop + alwaysOnTop confirmed AFTER showInactive so the window
        // is definitely in the visible stack before we raise it.
        existingWindow.moveTop();
        keepOverlayAboveGame(existingWindow);
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
      hasShadow,
      webPreferences: {
        preload: getElectronBuildFile(preloadFileName),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    rendererReady = false;
    pendingOverlayEvents.length = 0;
    writeOverlayWindow(createdWindow);
    attachRendererDiagnostics(createdWindow);

    hardenBrowserWindowNavigation(createdWindow, {
      label: windowLabel,
      allowedFilePaths: [overlayWindowFile],
      log,
    });

    void createdWindow.loadFile(
      overlayWindowFile,
      fileSearch ? { search: fileSearch } : undefined,
    );
    positionOverlayWindow(lastOverlayAnchorMeta);
    // keepOverlayAboveGame/moveTop reveal a hidden window on Windows, so the
    // pre-warm path (show:false) must not touch z-order - the show branch here
    // and the existing-window branch above both reapply it.
    if (shouldShow) {
      keepOverlayAboveGame(createdWindow);
      createdWindow.moveTop();
      createdWindow.showInactive();
      keepOverlayAboveGame(createdWindow);
      setOverlayInteractiveMode(readInteractiveMode());
    }
    createdWindow.on("closed", () => {
      clearOverlayAutoHideTimer();
      if (moveSaveTimer) {
        clearTimeout(moveSaveTimer);
        moveSaveTimer = null;
      }
      writeOverlayWindow(null);
      rendererReady = false;
      pendingOverlayEvents.length = 0;
    });
    attachBoundsPersistence(createdWindow);
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

    if (targetWindow.webContents.isLoadingMainFrame() || !rendererReady) {
      pendingOverlayEvents.push({ channel, payload });
      return;
    }

    sendNow();
  }

  function markRendererReady(senderId: number): boolean {
    const targetWindow = readOverlayWindow();
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    if (targetWindow.webContents.id !== senderId) return false;

    rendererReady = true;
    const pending = pendingOverlayEvents.splice(0);
    for (const event of pending) {
      targetWindow.webContents.send(event.channel, event.payload);
    }
    return true;
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
      keepOverlayAboveGame(overlayWindow);
      overlayWindow.moveTop();
      overlayWindow.focus();
    } else {
      if (ignoreMouseEventsForward) {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      } else {
        overlayWindow.setIgnoreMouseEvents(true);
      }
      overlayWindow.setFocusable(true);
      overlayWindow.blur();
      keepOverlayAboveGame(overlayWindow);
      overlayWindow.moveTop();
      overlayWindow.showInactive();
    }
  }

  return {
    getOverlayBoundsForActiveDisplay,
    positionOverlayWindow,
    createOverlayWindow,
    clearOverlayAutoHideTimer,
    scheduleOverlayAutoHide,
    sendOverlayEvent,
    markRendererReady,
    setAnchorMeta,
    getAnchorMeta,
    setOverlayInteractiveMode,
  };
}
