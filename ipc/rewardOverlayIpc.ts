import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, screen, app } from "electron";
import ctx from "./context";
import {
  assertMainRendererSender,
  assertOverlayRendererSender,
  handleAuthorized,
  onAuthorized,
} from "./ipcSecurity";
import { createOverlayScanController } from "./overlay/scan";
import { createRelicSelectionController } from "./overlay/relicSelection";
import { registerZOrderSubscriber } from "./overlay/zOrder";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";

import * as relicService from "../services/relicService";
import {
  captureSourceMeta,
  detectRelicSelectionEra,
  scanRewardsDetailed,
} from "../services/rewardScanner";
import { fetchPriceBySlug, getCachedPriceBySlug } from "../services/wfmStatsPrice";
import * as warframeStatus from "../services/warframeStatus";
import {
  isRelicRecommendationOverlayEnabled,
  isRelicRewardsOverlayEnabled,
} from "../config/runtime/overlaySettings";
import {
  OVERLAY_CLOSE,
  OVERLAY_GET_RELIC_ITEMS,
  OVERLAY_GET_PRICE,
  OVERLAY_GET_DRAG_HINT,
  TOGGLE_OVERLAY,
  SIMULATE_RELIC_TRIGGER,
  OVERLAY_PUSH_RELIC_FILTERS,
} from "../config/shared/ipcChannels";

const log = withScope("rewardOverlayIpc");

let persistOverlaySettings: (() => void) | null = null;
const rememberOverlayWindowBounds = createOverlayWindowBoundsChangeHandler({
  ctx,
  save: () => {
    persistOverlaySettings?.();
  },
});

const rewardScanner = {
  captureSourceMeta,
  detectRelicSelectionEra,
  scanRewardsDetailed,
};

const wfmStatsPrice = {
  fetchPriceBySlug,
  getCachedPriceBySlug,
};

const APP_ROOT = app.getAppPath();
const OVERLAY_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
// Prices and ducat meta live in the snapshot cache; price-cache.json is not written.
const PRICE_CACHE_FILE = path.join(app.getPath("userData"), "snapshot-cache.json");

export const rewardWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  // fits a card whose set-part chips (30px icons) wrap to two rows + best bar
  windowHeight: 236,
  windowStateKey: "reward",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

export const plannerWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  getOverlayWindow: () => ctx.plannerOverlayWindow,
  setOverlayWindow: (window) => {
    ctx.plannerOverlayWindow = window;
  },
  getOverlayInteractiveMode: () => ctx.overlayInteractiveMode,
  setOverlayInteractiveModeState: (enabled) => {
    ctx.overlayInteractiveMode = !!enabled;
  },
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  placement: "top-right",
  windowWidth: 460,
  windowHeight: 320,
  fileSearch: "mode=planner",
  transparent: false,
  backgroundColor: "#060a12",
  windowStateKey: "planner",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

function syncOverlayWindowZOrder(
  win: InstanceType<typeof BrowserWindow> | null,
  warframeFocused: boolean,
): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;

  if (warframeFocused) {
    win.setSkipTaskbar(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  } else if (win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

registerZOrderSubscriber({
  isActive: () => Boolean(ctx.overlayWindow?.isVisible() || ctx.plannerOverlayWindow?.isVisible()),
  sync: (warframeFocused) => {
    syncOverlayWindowZOrder(ctx.overlayWindow, warframeFocused);
    syncOverlayWindowZOrder(ctx.plannerOverlayWindow, warframeFocused);
  },
});

let scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: rewardWindowsController,
  warframeStatus,
});

const relicSelectionController = createRelicSelectionController({
  log,
  ctx,
  windows: plannerWindowsController,
  relicService,
  rewardScanner,
  wfmStatsPrice,
  warframeStatus,
  fs,
  cacheFilePath: PRICE_CACHE_FILE,
});

export function configureOverlaySettingsPersistence(persist: () => void): void {
  persistOverlaySettings = persist;
}

/** Create the planner window hidden so the first relic trigger shows it instantly. */
export function warmPlannerOverlayWindow(): void {
  if (!isRelicRecommendationOverlayEnabled(ctx.overlaySettings)) return;
  if (ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()) return;
  plannerWindowsController.createOverlayWindow({ show: false });
}

export function onRelicRewardTrigger(
  source: string,
  stalenessMs: number,
  pushOverlayInteractionMode: () => void,
  pushOverlayThemeVars: () => void,
  bringOverlayToWarframeDisplayIfAvailable: () => Promise<void>,
): void {
  if (!isRelicRewardsOverlayEnabled(ctx.overlaySettings)) {
    log.info(`[OverlayRoute] reward overlay disabled; source=${source}`);
    return;
  }
  log.info(`[OverlayRoute] trigger=reward source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  rewardWindowsController.createOverlayWindow();
  rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  scanController.onRelicRewardTrigger(source, stalenessMs);
}

export function notifyRewardUiReady(): void {
  scanController.notifyRewardUiReady();
}

export function onRelicSelectionTrigger(
  source: string,
  pushOverlayInteractionMode: () => void,
  pushOverlayThemeVars: () => void,
  bringOverlayToWarframeDisplayIfAvailable: () => Promise<void>,
): void {
  if (!isRelicRecommendationOverlayEnabled(ctx.overlaySettings)) {
    log.info(`[OverlayRoute] planner overlay disabled; source=${source}`);
    return;
  }
  log.info(`[OverlayRoute] trigger=planner source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  plannerWindowsController.createOverlayWindow();
  plannerWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  void relicSelectionController.onRelicSelectionTrigger(source);
}

export function setActiveMissionTag(tag: string): void {
  relicSelectionController.setActiveMissionTag?.(tag);
}

export function onRelicSelectionClose(pushOverlayInteractionMode: () => void): void {
  relicSelectionController.resetMissionTier?.();
  const win = ctx.plannerOverlayWindow;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  plannerWindowsController.clearOverlayAutoHideTimer();
  ctx.overlayInteractiveMode = false;
  pushOverlayInteractionMode();
  win.hide();
  log.info("[OverlayClose] planner closed via Dialog::SendResult");
}

export function register(
  pushOverlayInteractionMode: () => void,
  pushOverlayThemeVars: () => void,
): void {
  onAuthorized(OVERLAY_CLOSE, assertOverlayRendererSender, (event) => {
    rewardWindowsController.clearOverlayAutoHideTimer();
    plannerWindowsController.clearOverlayAutoHideTimer();
    relicSelectionController.suppressReopenForClose?.();

    // Reset interactive mode so the next trigger opens the overlay in passive mode.
    ctx.overlayInteractiveMode = false;
    pushOverlayInteractionMode();

    const senderId = Number(event?.sender?.id || 0);
    if (
      ctx.plannerOverlayWindow &&
      !ctx.plannerOverlayWindow.isDestroyed() &&
      senderId === ctx.plannerOverlayWindow.webContents.id
    ) {
      ctx.plannerOverlayWindow.hide();
      return;
    }

    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      ctx.overlayWindow.hide();
    }
  });

  handleAuthorized(OVERLAY_GET_RELIC_ITEMS, assertOverlayRendererSender, async () => {
    return relicService.getRelicRewardItems();
  });

  // move-hint state: unlock hotkey + whether a live overlay was ever dragged (setup doesn't count)
  handleAuthorized(OVERLAY_GET_DRAG_HINT, assertOverlayRendererSender, async () => ({
    hotkey: ctx.overlaySettings.interactionHotkeyEnabled
      ? String(ctx.overlaySettings.interactionHotkey || "")
      : null,
    dismissed: ctx.overlaySettings.overlayDragHintDismissed === true,
  }));

  handleAuthorized(
    OVERLAY_GET_PRICE,
    assertOverlayRendererSender,
    async (_event, slug: unknown) => {
      return wfmStatsPrice.fetchPriceBySlug(slug);
    },
  );

  onAuthorized(TOGGLE_OVERLAY, assertMainRendererSender, () => {
    if (!isRelicRewardsOverlayEnabled(ctx.overlaySettings)) return;
    rewardWindowsController.clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      rewardWindowsController.createOverlayWindow();
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
      ctx.overlayWindow.showInactive();
    }
  });

  onAuthorized(SIMULATE_RELIC_TRIGGER, assertMainRendererSender, () => {
    onRelicRewardTrigger(
      "simulate",
      0,
      pushOverlayInteractionMode,
      pushOverlayThemeVars,
      async () => {},
    );
  });

  onAuthorized(
    OVERLAY_PUSH_RELIC_FILTERS,
    assertMainRendererSender,
    (_event, rawFilters: unknown) => {
      if (!rawFilters || typeof rawFilters !== "object") return;
      const filters = rawFilters as Record<string, unknown>;
      relicSelectionController.setDesktopFilters({
        squadSize: typeof filters.squadSize === "number" ? filters.squadSize : undefined,
        tierFilter: typeof filters.tierFilter === "string" ? filters.tierFilter : null,
      });
    },
  );
}
