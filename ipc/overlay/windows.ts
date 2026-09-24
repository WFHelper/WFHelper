import path from "node:path";
import { clampNumber } from "../../config/shared/numeric";
import { baseZoomForDisplay } from "../../config/runtime/uiScale";
import { OVERLAY_CONTENT_VISIBLE } from "../../config/shared/ipcChannels";
import { REWARD_OVERLAY_CANVAS } from "../../config/shared/rewardOverlayLayout";
import {
  isNativeWayland as linuxIsNativeWayland,
  isTilingCompositor as linuxIsTilingCompositor,
} from "../../services/linuxDisplayBackend";
import {
  CLICK_THROUGH_REASSERT_DELAYS_MS,
  scheduleClickThroughReassert,
  setClickThrough,
} from "./clickThrough";
import { createKeepMappedMode } from "./keepMapped";
import {
  createLayerPresentation,
  resolveOutputForGame,
  type LayerGeometry,
} from "./layerPresentation";
import { probeLayerShell } from "../../services/layerShell";
import { placeWindowOnGameOutput } from "../../services/waylandCompositor";
import type {
  OverlaySavedWindowBounds,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings";

// Re-stacking a window in its last seconds before a queued hide crashes under injected hooks.
export const HIDE_IMMINENT_MS = 3_000;

const OVERLAY_WINDOW_BOUNDS = Object.freeze({
  width: REWARD_OVERLAY_CANVAS.width,
  height: 140,
  horizontalMargin: 16,
  bottomMargin: 18,
  topMargin: 8,
  defaultYRatio: 0.56,
  anchorGapRatio: 0.04,
  anchorMinRatio: 0.32,
  anchorMaxRatio: 0.82,
});

const OVERLAY_AREA_MARGIN = Object.freeze({
  x: OVERLAY_WINDOW_BOUNDS.horizontalMargin,
  top: OVERLAY_WINDOW_BOUNDS.topMargin,
  bottom: OVERLAY_WINDOW_BOUNDS.bottomMargin,
});
const NO_AREA_MARGIN = Object.freeze({ x: 0, top: 0, bottom: 0 });

type AreaRect = { x: number; y: number; width: number; height: number };

export function findDisplayById<T extends { id: number | string }>(
  displays: readonly T[],
  displayId: unknown,
): T | null {
  if (!displayId) return null;
  const wanted = String(displayId);
  return displays.find((display) => String(display.id) === wanted) || null;
}

export function clampIntoArea(
  x: number,
  y: number,
  width: number,
  height: number,
  area: AreaRect,
  margin: { x: number; top: number; bottom: number } = NO_AREA_MARGIN,
): { x: number; y: number } {
  const maxX = area.x + area.width - width - margin.x;
  const maxY = area.y + area.height - height - margin.bottom;
  return {
    x: Math.round(Math.max(area.x + margin.x, Math.min(maxX, x))),
    y: Math.round(Math.max(area.y + margin.top, Math.min(maxY, y))),
  };
}

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
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
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
  /** Stable, untranslated window title: compositor rules match on it. */
  windowTitle?: string;
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
  transparent?: boolean;
  backgroundColor?: string;
  windowStateKey?: OverlayWindowKey;
  onWindowBoundsChanged?: (key: OverlayWindowKey, bounds: OverlaySavedWindowBounds) => void;
  persistBoundsWhenPassive?: boolean;
  neverClickThrough?: boolean;
  onWindowCreated?: (window: import("electron").BrowserWindow) => void;
  /** A shown overlay was hidden for good; unfocus and transient hides do not count. */
  onPresentationEnd?: () => void;
  canRaise?: () => boolean;
  platform?: NodeJS.Platform;
  isNativeWayland?: () => boolean;
  isTilingCompositor?: () => boolean;
  placeOnGameOutput?: (title: string, output: string | null) => Promise<boolean>;
  createPresentation?: (
    options: Parameters<typeof createLayerPresentation>[0],
  ) => ReturnType<typeof createLayerPresentation> | null;
};

function defaultPresentationFactory(
  options: Parameters<typeof createLayerPresentation>[0],
): ReturnType<typeof createLayerPresentation> | null {
  return probeLayerShell()?.available ? createLayerPresentation(options) : null;
}

interface MovableWindow {
  getBounds(): { x: number; y: number };
  setPosition(x: number, y: number, animate?: boolean): void;
}

// setPosition, never setBounds: writing the size let the window drift when Windows
// adjusted the frame.
export function moveWindowBy(win: MovableWindow, dx: number, dy: number): void {
  const { x, y } = win.getBounds();
  win.setPosition(x + dx, y + dy, false);
}

const layerMovers = new Map<number, (dx: number, dy: number) => void>();

/** A layer surface has no window position to write, so its controller re-anchors instead. */
export function moveOverlayWindowBy(
  win: MovableWindow & { webContents?: { id: number } },
  dx: number,
  dy: number,
): void {
  const mover = win.webContents ? layerMovers.get(win.webContents.id) : undefined;
  if (mover) {
    mover(dx, dy);
    return;
  }
  moveWindowBy(win, dx, dy);
}

export function createOverlayWindowBoundsChangeHandler(
  options: OverlaySettingsPersistenceOptions,
): (key: OverlayWindowKey, bounds: OverlaySavedWindowBounds) => void {
  return (key, bounds) => {
    options.ctx.overlaySettings = {
      ...options.ctx.overlaySettings,
      ...(key === "arbiSummary" ? {} : { overlayDragHintDismissed: true }),
      overlayWindowBounds: {
        ...(options.ctx.overlaySettings.overlayWindowBounds || {}),
        [key]: { ...options.ctx.overlaySettings.overlayWindowBounds?.[key], ...bounds },
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
    windowTitle,
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
    transparent = true,
    backgroundColor = "#060a12",
    windowStateKey,
    onWindowBoundsChanged,
    persistBoundsWhenPassive = false,
    neverClickThrough = false,
    onWindowCreated,
    onPresentationEnd,
    canRaise = () => true,
    platform = process.platform,
    isNativeWayland = linuxIsNativeWayland,
    isTilingCompositor = linuxIsTilingCompositor,
    placeOnGameOutput = placeWindowOnGameOutput,
    createPresentation = defaultPresentationFactory,
  } = options;

  // Linux overlays are always transparent: only a transparent window can be blanked
  // instead of unmapped, and each map steals game focus on native Wayland.
  const transparentWindow = transparent || platform === "linux";
  const resizeMinWidth = Math.round(Math.min(windowWidth * 0.75, 240));
  const resizeMinHeight = Math.round(Math.min(windowHeight * 0.75, 100));

  let lastOverlayAnchorMeta: OverlayAnchorMeta | null = null;
  let overlayAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayAutoHideAt = 0;
  let suppressMoveSave = false;
  // Windows delivers resize events after setBounds returns, so a timer-based suppression
  // races them.
  let selfRequestedSizes: Array<{ width: number; height: number }> = [];
  let moveSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeResizeInProgress = false;
  let contentHeight: number | null = null;
  let pendingContentHeight: number | null = null;
  let rendererReady = false;
  let logicalVisible = false;
  let hiddenByUnfocus = false;
  let layer: ReturnType<typeof createLayerPresentation> | null = null;
  let lastAppliedInteractive: boolean | null = null;
  let clickThroughApplied = false;
  let lastAutoHideDelayMs = 0;
  const lastOverlayEvents = new Map<string, unknown>();
  const pendingOverlayEvents: Array<{ channel: string; payload?: unknown }> = [];
  let raiseReassertTimers: Array<ReturnType<typeof setTimeout>> = [];
  const keepMapped = createKeepMappedMode({
    label: `OverlayWindow ${windowLabel}`,
    transparent: transparentWindow,
    platform,
    isNativeWayland,
    isTilingCompositor,
    log,
  });

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

    const byMeta = findDisplayById(screen.getAllDisplays(), metaDisplayId);
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

  function readUserScale(): number {
    const perWindow = windowStateKey
      ? (ctx.overlaySettings?.overlayWindowScales || {})[windowStateKey]
      : undefined;
    return clampNumber(perWindow ?? ctx.overlaySettings?.overlayScale, 0.75, 1.5, 1);
  }

  function computeOverlayZoomFactor(display: import("electron").Display): number {
    return Number((baseZoomForDisplay(display.workArea) * readUserScale()).toFixed(3));
  }

  function getOverlayBoundsForActiveDisplay(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ) {
    const savedBounds = readSavedBounds();
    const display =
      (savedBounds ? findDisplayById(screen.getAllDisplays(), savedBounds.displayId) : null) ||
      getDisplayForOverlay(anchorMeta);
    const zoomFactor = computeOverlayZoomFactor(display);
    const scaledWidth = Math.max(
      resizeMinWidth,
      Math.round((savedBounds?.width ?? windowWidth) * zoomFactor),
    );
    const scaledHeight = Math.max(
      resizeMinHeight,
      Math.round(
        (savedBounds?.height ??
          (savedBounds?.width == null ? contentHeight : null) ??
          windowHeight) * zoomFactor,
      ),
    );
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

    let x = Math.round(area.x + (area.width - width) / 2);
    let y = Math.round(area.y + area.height * getAnchorRatio(anchorMeta));

    if (savedBounds) {
      x = savedBounds.x;
      y = savedBounds.y;
    } else if (placement === "top-left") {
      x = area.x;
      y = area.y + Math.max(0, topOffset);
    } else if (placement === "top-right") {
      x = area.x + area.width;
      y = area.y + Math.max(0, topOffset);
    }

    return {
      ...clampIntoArea(x, y, width, height, area, OVERLAY_AREA_MARGIN),
      width,
      height,
      zoomFactor,
    };
  }

  /** A layer surface is placed as a margin from its output's edge, not a screen position. */
  function layerGeometry(): LayerGeometry | null {
    const bounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);
    const display = displayMatchingBounds(bounds) || getDisplayForOverlay(lastOverlayAnchorMeta);
    // Exclusive zone -1, so margins are measured from the whole output.
    const area = display?.bounds;
    if (!area) return null;
    return {
      x: bounds.x - area.x,
      y: bounds.y - area.y,
      width: bounds.width,
      height: bounds.height,
      zoomFactor: bounds.zoomFactor,
    };
  }

  function moveLayerOverlayBy(dx: number, dy: number): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    const bounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);
    const display = displayMatchingBounds(bounds) || getDisplayForOverlay(lastOverlayAnchorMeta);
    const displayId = display ? String(display.id) : null;
    onWindowBoundsChanged(windowStateKey, {
      x: bounds.x + dx,
      y: bounds.y + dy,
      ...(displayId ? { displayId } : {}),
    });
    layer?.applyGeometry();
  }

  function setSelfRequestedBounds(
    overlayWindow: import("electron").BrowserWindow,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    selfRequestedSizes = [{ width: rect.width, height: rect.height }];
    overlayWindow.setBounds(rect, false);
    // Windows grants a frame up to 16x8 smaller than the one asked for.
    const granted = overlayWindow.getBounds();
    selfRequestedSizes.push({ width: granted.width, height: granted.height });
  }

  function positionOverlayWindow(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (nativeResizeInProgress) return;
    flushPendingBoundsSave(overlayWindow);
    applyPendingContentHeight(false);
    if (isLayerMode()) {
      layer?.applyGeometry();
      return;
    }
    const { zoomFactor, ...rect } = getOverlayBoundsForActiveDisplay(anchorMeta);
    suppressMoveSave = true;
    setSelfRequestedBounds(overlayWindow, rect);
    overlayWindow.webContents.setZoomFactor(zoomFactor);
    setTimeout(() => {
      suppressMoveSave = false;
    }, 0);
  }

  function flushPendingBoundsSave(overlayWindow: import("electron").BrowserWindow): void {
    if ((!moveSaveTimer && !resizeSaveTimer) || suppressMoveSave) return;
    saveCurrentWindowBounds(overlayWindow, resizeSaveTimer !== null);
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    moveSaveTimer = resizeSaveTimer = null;
  }

  function storeContentHeight(next: number): boolean {
    const window = readOverlayWindow();
    if (!window || window.isDestroyed()) return false;
    const saved = readSavedBounds();
    if (saved?.width != null || saved?.height != null) {
      pendingContentHeight = null;
      return false;
    }
    if (nativeResizeInProgress || resizeSaveTimer) {
      pendingContentHeight = next;
      return false;
    }
    pendingContentHeight = null;
    if (contentHeight === next) return false;
    contentHeight = next;
    return true;
  }

  function applyPendingContentHeight(reposition: boolean): void {
    const pending = pendingContentHeight;
    if (pending === null) return;
    pendingContentHeight = null;
    if (storeContentHeight(pending) && reposition) positionOverlayWindow();
  }

  function fitOverlayContentHeight(logicalHeight: number): void {
    if (!Number.isFinite(logicalHeight) || logicalHeight <= 0 || logicalHeight > 10_000) return;
    if (storeContentHeight(Math.max(windowHeight, Math.ceil(logicalHeight)))) {
      positionOverlayWindow();
    }
  }

  function displayMatchingBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): import("electron").Display | null {
    try {
      return screen.getDisplayMatching(bounds) || null;
    } catch {
      return null;
    }
  }

  function saveCurrentWindowBounds(
    overlayWindow: import("electron").BrowserWindow,
    saveSize = false,
  ): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    if (suppressMoveSave || overlayWindow.isDestroyed()) return;
    if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
    const bounds = overlayWindow.getBounds();
    const display = displayMatchingBounds(bounds);
    const displayId = display ? String(display.id) : null;
    const zoom = saveSize ? overlayWindow.webContents.getZoomFactor() : 1;
    onWindowBoundsChanged(windowStateKey, {
      x: bounds.x,
      y: bounds.y,
      ...(displayId ? { displayId } : {}),
      ...(saveSize ? { width: bounds.width / zoom, height: bounds.height / zoom } : {}),
    });
  }

  /** Windows trims a pixel or two off a frame it grants, so never compare exactly. */
  function sizeMatches(
    a: { width: number; height: number },
    b: { width: number; height: number } | null,
  ): boolean {
    if (!b) return false;
    return Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  }

  function isSelfRequestedSize(bounds: { width: number; height: number }): boolean {
    return selfRequestedSizes.some((size) => sizeMatches(bounds, size));
  }

  function attachBoundsPersistence(overlayWindow: import("electron").BrowserWindow): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    if (platform === "win32") {
      overlayWindow.on("will-resize", () => {
        if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
        nativeResizeInProgress = true;
        if (moveSaveTimer) clearTimeout(moveSaveTimer);
        if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
        moveSaveTimer = resizeSaveTimer = null;
      });
      overlayWindow.on("resized", () => {
        if (!nativeResizeInProgress) return;
        nativeResizeInProgress = false;
        saveCurrentWindowBounds(overlayWindow, true);
        applyPendingContentHeight(true);
      });
    }
    overlayWindow.on("move", () => {
      if (suppressMoveSave || nativeResizeInProgress) return;
      if (moveSaveTimer) clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(() => {
        moveSaveTimer = null;
        saveCurrentWindowBounds(overlayWindow);
      }, 250);
    });
    overlayWindow.on("resize", () => {
      if (nativeResizeInProgress || suppressMoveSave || overlayWindow.isDestroyed()) return;
      if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
      if (isSelfRequestedSize(overlayWindow.getBounds())) return;
      selfRequestedSizes = [];
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(() => {
        resizeSaveTimer = null;
        saveCurrentWindowBounds(overlayWindow, true);
        applyPendingContentHeight(true);
      }, 250);
    });
  }

  // A map is not instant on Wayland, so the compositor may not know the window yet.
  const PLACEMENT_ATTEMPT_DELAYS_MS = [120, 500];

  /** Native Wayland ignores setPosition, so the compositor is asked to move the window. */
  async function placeOverlayOnGameOutput(): Promise<void> {
    if (platform !== "linux" || !windowTitle || !isNativeWayland()) return;
    const target = await resolveOutputForGame();
    for (const delay of PLACEMENT_ATTEMPT_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const overlayWindow = readOverlayWindow();
      if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
      if (await placeOnGameOutput(windowTitle, target)) return;
    }
  }

  function keepOverlayAboveGame(overlayWindow: import("electron").BrowserWindow): void {
    overlayWindow.setSkipTaskbar(true);
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  }

  function isKeepMappedActive(): boolean {
    if (isLayerMode()) return false;
    return keepMapped.isActive();
  }

  function isLayerMode(): boolean {
    return layer !== null;
  }

  /** Wayland has no stacking to re-assert; Windows still needs it for the first map. */
  function raiseReassertPointless(): boolean {
    return isKeepMappedActive() && platform === "linux";
  }

  function showLayerSurface(): void {
    logicalVisible = true;
    void layer?.show().then((up) => {
      if (!up)
        log.warn(`[OverlayWindow] ${windowLabel} got no layer surface; nothing is on screen`);
    });
  }

  function layerModeAllowed(): boolean {
    return platform === "linux" && isNativeWayland();
  }

  function layerWantsInput(): boolean {
    return neverClickThrough || readInteractiveMode();
  }

  function applyClickThrough(overlayWindow: import("electron").BrowserWindow, force = false): void {
    if (neverClickThrough && !force) return;
    clickThroughApplied = true;
    setClickThrough(overlayWindow, true, platform);
  }

  // X11 never hands input back after click-through: setIgnoreMouseEvents(false) leaves
  // the empty input shape, so the window must be rebuilt to take clicks.
  function needsRebuildForInteractive(): boolean {
    return platform === "linux" && clickThroughApplied && !isNativeWayland();
  }

  function rebuildForInteractive(): void {
    const staleWindow = readOverlayWindow();
    if (!staleWindow || staleWindow.isDestroyed()) return;

    const replay = [...lastOverlayEvents];
    const bounds = staleWindow.getBounds();
    const autoHideWasPending = overlayAutoHideTimer !== null;
    log.warn(`[OverlayWindow] rebuilding ${windowLabel} for interactive mode`);
    staleWindow.destroy();

    createOverlayWindow({ show: true });
    const freshWindow = readOverlayWindow();
    if (!freshWindow || freshWindow.isDestroyed()) return;
    suppressMoveSave = true;
    setSelfRequestedBounds(freshWindow, bounds);
    setTimeout(() => {
      suppressMoveSave = false;
    }, 0);
    for (const [channel, payload] of replay) sendOverlayEvent(channel, payload);
    if (autoHideWasPending) scheduleOverlayAutoHide(lastAutoHideDelayMs);
  }

  // An immediate raise can lose the race against the map.
  function scheduleRaiseReassert(overlayWindow: import("electron").BrowserWindow): void {
    for (const timer of raiseReassertTimers) clearTimeout(timer);
    raiseReassertTimers = CLICK_THROUGH_REASSERT_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        if (overlayWindow.isDestroyed() || !isOverlayWindowVisible()) return;
        const hideDueIn = overlayHideDueIn();
        if (hideDueIn !== null && hideDueIn <= HIDE_IMMINENT_MS) return;
        if (!canRaise()) {
          overlayWindow.setAlwaysOnTop(false);
          overlayWindow.setVisibleOnAllWorkspaces(false);
          return;
        }
        keepOverlayAboveGame(overlayWindow);
        overlayWindow.moveTop();
      }, delay),
    );
  }

  function setKeepMappedContentVisible(visible: boolean): void {
    logicalVisible = visible;
    sendOverlayEvent(OVERLAY_CONTENT_VISIBLE, visible);
  }

  function showKeepMapped(overlayWindow: import("electron").BrowserWindow): void {
    keepMapped.present(overlayWindow, setKeepMappedContentVisible);
    keepOverlayAboveGame(overlayWindow);
    if (neverClickThrough) setClickThrough(overlayWindow, false, platform);
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
      log.warn(`[OverlayWindow] ${windowLabel} failed to load ${url}: ${code} ${description}`);
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
      if (event.level === "info") {
        log.info(`[OverlayWindow] ${windowLabel} console: ${event.message}`);
        return;
      }
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

    if (existingWindow && !existingWindow.isDestroyed()) {
      positionOverlayWindow(lastOverlayAnchorMeta);
      keepOverlayAboveGame(existingWindow);
      if (shouldShow) {
        if (isLayerMode()) {
          showLayerSurface();
        } else if (isKeepMappedActive()) {
          showKeepMapped(existingWindow);
        } else if (!existingWindow.isVisible()) {
          existingWindow.showInactive();
          // moveTop after showInactive: the window must be in the visible stack first.
          existingWindow.moveTop();
          keepOverlayAboveGame(existingWindow);
          void placeOverlayOnGameOutput();
          const bounds = existingWindow.getBounds();
          const visible = existingWindow.isVisible();
          log.warn(
            `[OverlayWindow] shown existing window visible=${visible} bounds=${JSON.stringify(bounds)}`,
          );
          scheduleRaiseReassert(existingWindow);
        }
      }
      setOverlayInteractiveMode(readInteractiveMode());
      return;
    }

    const initialBounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);
    const nextLayer = layerModeAllowed()
      ? createPresentation({
          label: windowLabel,
          anchor: placement,
          log,
          resolveGeometry: layerGeometry,
        })
      : null;

    const createdWindow = new BrowserWindow({
      // Toolbar windows avoid Linux focus-on-map while still allowing explicit focus.
      // WFHELPER_NO_TOOLBAR_TYPE=1 drops it when a compositor eats overlay clicks.
      ...(platform === "linux" && process.env.WFHELPER_NO_TOOLBAR_TYPE !== "1"
        ? { type: "toolbar" }
        : {}),
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: resizeMinWidth,
      minHeight: resizeMinHeight,
      x: initialBounds.x,
      y: initialBounds.y,
      show: false,
      transparent: transparentWindow,
      backgroundColor: transparentWindow ? undefined : backgroundColor,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      focusable: false,
      hasShadow,
      webPreferences: {
        preload: getElectronBuildFile(preloadFileName),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(nextLayer ? { offscreen: true } : {}),
      },
    });

    if (windowTitle) {
      createdWindow.setTitle(windowTitle);
      createdWindow.on("page-title-updated", (event) => event.preventDefault());
    }

    layer?.hide();
    layer = nextLayer;
    layer?.attach(createdWindow, initialBounds.width, initialBounds.height);
    if (nextLayer) {
      const senderId = createdWindow.webContents.id;
      layerMovers.set(senderId, moveLayerOverlayBy);
      createdWindow.once("closed", () => layerMovers.delete(senderId));
    }

    rendererReady = false;
    logicalVisible = false;
    lastAppliedInteractive = null;
    clickThroughApplied = false;
    lastOverlayEvents.clear();
    pendingOverlayEvents.length = 0;
    writeOverlayWindow(createdWindow);
    attachRendererDiagnostics(createdWindow);

    hardenBrowserWindowNavigation(createdWindow, {
      label: windowLabel,
      allowedFilePaths: [overlayWindowFile],
      log,
    });

    void createdWindow.loadFile(overlayWindowFile, fileSearch ? { search: fileSearch } : undefined);
    positionOverlayWindow(lastOverlayAnchorMeta);
    // z-order calls un-hide a hidden window on Windows - only touch it when showing
    if (shouldShow) {
      // showInactive() first, or moveTop is what reveals the window and takes game focus.
      if (isLayerMode()) {
        showLayerSurface();
      } else {
        createdWindow.showInactive();
        keepOverlayAboveGame(createdWindow);
        createdWindow.moveTop();
        keepOverlayAboveGame(createdWindow);
        void placeOverlayOnGameOutput();
      }
      if (isKeepMappedActive()) keepMapped.present(createdWindow, setKeepMappedContentVisible);
      setOverlayInteractiveMode(readInteractiveMode());
      const reassertClickThrough = scheduleClickThroughReassert(
        createdWindow,
        () => applyClickThrough(createdWindow),
        {
          skip: readInteractiveMode,
          onFirstPass: () =>
            log.info(`[OverlayWindow] ${windowLabel} click-through re-asserted after map`),
        },
      );
      createdWindow.webContents.once("did-finish-load", reassertClickThrough);
      if (!raiseReassertPointless()) scheduleRaiseReassert(createdWindow);
    }
    createdWindow.on("closed", () => {
      // The interactive rebuild destroys and recreates within one tick, so a late
      // event must not tear down the replacement.
      if (readOverlayWindow() !== createdWindow) return;
      layer?.hide();
      layer = null;
      clearOverlayAutoHideTimer();
      if (moveSaveTimer) {
        clearTimeout(moveSaveTimer);
        moveSaveTimer = null;
      }
      if (resizeSaveTimer) {
        clearTimeout(resizeSaveTimer);
        resizeSaveTimer = null;
      }
      nativeResizeInProgress = false;
      contentHeight = null;
      pendingContentHeight = null;
      selfRequestedSizes = [];
      writeOverlayWindow(null);
      rendererReady = false;
      logicalVisible = false;
      hiddenByUnfocus = false;
      pendingOverlayEvents.length = 0;
    });
    if (!isLayerMode()) attachBoundsPersistence(createdWindow);
    createdWindow.on("blur", () => {
      if (createdWindow.isDestroyed() || readOverlayWindow() !== createdWindow) return;
      if (isOverlayWindowVisible() && !raiseReassertPointless())
        scheduleRaiseReassert(createdWindow);
    });
    // Events sent while the page is still loading reach a renderer with no listeners.
    onWindowCreated?.(createdWindow);
  }

  function overlayHideDueIn(): number | null {
    if (overlayAutoHideTimer === null) return null;
    return Math.max(0, overlayAutoHideAt - Date.now());
  }

  function clearOverlayAutoHideTimer(): void {
    if (!overlayAutoHideTimer) return;
    clearTimeout(overlayAutoHideTimer);
    overlayAutoHideTimer = null;
  }

  function scheduleOverlayAutoHide(delayMs: number): void {
    clearOverlayAutoHideTimer();

    const delay = Math.max(250, Math.floor(Number(delayMs) || 0));
    lastAutoHideDelayMs = delay;
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    overlayAutoHideAt = Date.now() + delay;
    overlayAutoHideTimer = setTimeout(() => {
      overlayAutoHideTimer = null;
      hiddenByUnfocus = false;
      if (isOverlayWindowVisible()) {
        hideOverlayWindow();
      }
    }, delay);
  }

  function isOverlayWindowVisible(): boolean {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    if (isLayerMode()) return logicalVisible;
    if (!overlayWindow.isVisible()) return false;
    return isKeepMappedActive() ? logicalVisible : true;
  }

  /** `transient` hides for a recapture and shows again, so it ends no presentation. */
  function hideOverlayWindow(options: { transient?: boolean } = {}): void {
    const wasShown = isOverlayWindowVisible();
    const overlayWindow = readOverlayWindow();
    if (overlayWindow && !overlayWindow.isDestroyed()) flushPendingBoundsSave(overlayWindow);
    hideWindow();
    if (wasShown && !options.transient) onPresentationEnd?.();
  }

  function hideWindow(): void {
    hiddenByUnfocus = false;
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (isLayerMode()) {
      logicalVisible = false;
      layer?.hide();
      return;
    }
    if (keepMapped.hide(overlayWindow, setKeepMappedContentVisible)) {
      applyClickThrough(overlayWindow, true);
      if (overlayWindow.isFocused()) overlayWindow.blur();
      setFocusableIfChanged(overlayWindow, false);
      return;
    }
    overlayWindow.hide();
  }

  function hideForUnfocus(): boolean {
    if (!isOverlayWindowVisible() || readInteractiveMode()) return false;
    hideWindow();
    hiddenByUnfocus = true;
    return true;
  }

  function isHiddenByUnfocus(): boolean {
    return hiddenByUnfocus && !isOverlayWindowVisible();
  }

  function restoreAfterUnfocus(): boolean {
    if (!isHiddenByUnfocus()) return false;
    hiddenByUnfocus = false;
    showOverlayWindowInactive();
    return true;
  }

  function showOverlayWindowInactive(): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (isLayerMode()) {
      showLayerSurface();
      return;
    }
    if (isKeepMappedActive()) {
      showKeepMapped(overlayWindow);
    } else {
      overlayWindow.showInactive();
      scheduleRaiseReassert(overlayWindow);
    }
    setOverlayInteractiveMode(readInteractiveMode());
  }

  function sendOverlayEvent(channel: string, payload?: unknown): void {
    lastOverlayEvents.delete(channel);
    lastOverlayEvents.set(channel, payload);

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
    // The navigation commit resets a zoom set while loadFile was in flight.
    if (isLayerMode()) layer?.applyGeometry();
    else targetWindow.webContents.setZoomFactor(getOverlayBoundsForActiveDisplay().zoomFactor);
    const pending = pendingOverlayEvents.splice(0);
    const keepMappedActive = isKeepMappedActive();
    for (const event of pending) {
      if (keepMappedActive && event.channel === OVERLAY_CONTENT_VISIBLE) continue;
      targetWindow.webContents.send(event.channel, event.payload);
    }
    if (keepMappedActive) {
      targetWindow.webContents.send(OVERLAY_CONTENT_VISIBLE, logicalVisible);
    }
    if (!isLayerMode()) applyOverlayInputState(targetWindow, isOverlayWindowVisible());
    return true;
  }

  function setAnchorMeta(anchorMeta: OverlayAnchorMeta | null): void {
    lastOverlayAnchorMeta = anchorMeta || null;
  }

  function getAnchorMeta(): OverlayAnchorMeta | null {
    return lastOverlayAnchorMeta;
  }

  function applyOverlayInputState(
    overlayWindow: import("electron").BrowserWindow,
    visible: boolean,
    grantFocus = false,
  ): void {
    const interactive = readInteractiveMode() && visible;
    if (interactive || (neverClickThrough && visible)) {
      setClickThrough(overlayWindow, false, platform);
    } else {
      applyClickThrough(overlayWindow, !visible && isKeepMappedActive());
    }
    if (!interactive && overlayWindow.isFocused()) overlayWindow.blur();
    setFocusableIfChanged(
      overlayWindow,
      interactive && (grantFocus || overlayWindow.isFocusable()),
    );
  }

  // Electron 41 setFocusable(false) on a mapped window runs Chromium's Deactivate, which
  // calls SetForegroundWindow on the next visible window below it, focused or not.
  // setFocusable(true) does not deactivate, but it arms that hop for the way back.
  function setFocusableIfChanged(
    overlayWindow: import("electron").BrowserWindow,
    focusable: boolean,
  ): void {
    if (overlayWindow.isFocusable() !== focusable) overlayWindow.setFocusable(focusable);
  }

  function setOverlayInteractiveMode(enabled: boolean, options: { focus?: boolean } = {}): void {
    writeInteractiveMode(!!enabled);
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    const interactive = readInteractiveMode();
    const visible = isOverlayWindowVisible();

    if (isLayerMode()) {
      layer?.setInteractive(layerWantsInput());
      if (lastAppliedInteractive !== interactive) {
        lastAppliedInteractive = interactive;
        log.info(
          `[OverlayWindow] ${windowLabel} layer mode=${interactive ? "interactive" : "passive"}`,
        );
      }
      return;
    }

    if (interactive && visible && needsRebuildForInteractive()) {
      rebuildForInteractive();
      const rebuilt = readOverlayWindow();
      if (options.focus && rebuilt && !rebuilt.isDestroyed()) {
        applyOverlayInputState(rebuilt, isOverlayWindowVisible(), true);
        rebuilt.focus();
      }
      return;
    }

    applyOverlayInputState(overlayWindow, visible, options.focus === true);

    if (lastAppliedInteractive !== interactive) {
      lastAppliedInteractive = interactive;
      log.info(
        `[OverlayWindow] ${windowLabel} mode=${interactive ? "interactive" : "passive"} visible=${visible}`,
      );
    }

    if (!visible) return;

    if (!interactive && !canRaise()) {
      overlayWindow.setAlwaysOnTop(false);
      overlayWindow.setVisibleOnAllWorkspaces(false);
      return;
    }

    keepOverlayAboveGame(overlayWindow);
    overlayWindow.moveTop();
    if (interactive) {
      if (options.focus) overlayWindow.focus();
    } else if (!isKeepMappedActive()) {
      overlayWindow.showInactive();
    }
    // Either direction of the focusable flip can drop the window out of the topmost band.
    if (!raiseReassertPointless()) scheduleRaiseReassert(overlayWindow);
  }

  return {
    getOverlayBoundsForActiveDisplay,
    positionOverlayWindow,
    fitOverlayContentHeight,
    createOverlayWindow,
    clearOverlayAutoHideTimer,
    scheduleOverlayAutoHide,
    overlayHideDueIn,
    sendOverlayEvent,
    markRendererReady,
    setAnchorMeta,
    getAnchorMeta,
    setOverlayInteractiveMode,
    isKeepMappedActive,
    isOverlayWindowVisible,
    hideOverlayWindow,
    showOverlayWindowInactive,
    hideForUnfocus,
    isHiddenByUnfocus,
    restoreAfterUnfocus,
  };
}
