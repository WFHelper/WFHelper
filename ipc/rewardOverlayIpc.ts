import { getOverlayDescriptor } from "../config/shared/overlayLayout";
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
import {
  canRaiseOverlayWindows,
  registerZOrderSubscriber,
  syncOverlayWindowZOrder,
} from "./overlay/zOrder";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import { userDataPath } from "../services/userDataPath";

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
  OVERLAY_GET_PRICE,
  OVERLAY_GET_DRAG_HINT,
  TOGGLE_OVERLAY,
  SIMULATE_RELIC_TRIGGER,
  OVERLAY_PUSH_RELIC_FILTERS,
  RELIC_REWARD_CONTENT_HEIGHT,
} from "../config/shared/ipcChannels";
import { REWARD_OVERLAY_CANVAS } from "../config/shared/rewardOverlayLayout";

const log = withScope("rewardOverlayIpc");

let persistOverlaySettings: (() => boolean) | null = null;
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
const PRICE_CACHE_FILE = userDataPath("snapshot-cache.json");

export const rewardWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  // fits a card whose set-part chips (30px icons) wrap to two rows + best bar
  windowHeight: REWARD_OVERLAY_CANVAS.height,
  windowTitle: "WFHelper Relic Rewards",
  windowStateKey: "reward",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
  canRaise: canRaiseOverlayWindows,
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
  windowWidth: getOverlayDescriptor("planner").canvas.width,
  windowHeight: getOverlayDescriptor("planner").canvas.height,
  fileSearch: "mode=planner",
  transparent: true,
  windowTitle: "WFHelper Relic Planner",
  windowStateKey: "planner",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
  canRaise: canRaiseOverlayWindows,
});

registerZOrderSubscriber({
  isActive: () =>
    rewardWindowsController.isOverlayWindowVisible() ||
    plannerWindowsController.isOverlayWindowVisible(),
  sync: (warframeFocused) => {
    const keepRaised = process.platform === "win32" ? canRaiseOverlayWindows() : warframeFocused;
    syncOverlayWindowZOrder(rewardWindowsController, ctx.overlayWindow, keepRaised);
    syncOverlayWindowZOrder(plannerWindowsController, ctx.plannerOverlayWindow, keepRaised);
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

export function configureOverlaySettingsPersistence(persist: () => boolean): void {
  persistOverlaySettings = persist;
}

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

export function notifyRewardScreenClosed(stalenessMs: number): void {
  scanController.notifyRewardScreenClosed(stalenessMs);
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
  if (!plannerWindowsController.isOverlayWindowVisible()) return;
  plannerWindowsController.clearOverlayAutoHideTimer();
  ctx.overlayInteractiveMode = false;
  pushOverlayInteractionMode();
  plannerWindowsController.hideOverlayWindow();
  log.info("[OverlayClose] planner closed via Dialog::SendResult");
}

export function register(
  pushOverlayInteractionMode: () => void,
  pushOverlayThemeVars: () => void,
): void {
  onAuthorized(
    RELIC_REWARD_CONTENT_HEIGHT,
    assertOverlayRendererSender,
    (event, height: unknown) => {
      const reward = ctx.overlayWindow;
      if (!reward || reward.isDestroyed() || event.sender.id !== reward.webContents.id) return;
      if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > 10_000)
        return;
      rewardWindowsController.fitOverlayContentHeight(height);
    },
  );

  onAuthorized(OVERLAY_CLOSE, assertOverlayRendererSender, (event) => {
    rewardWindowsController.clearOverlayAutoHideTimer();
    plannerWindowsController.clearOverlayAutoHideTimer();
    relicSelectionController.suppressReopenForClose?.();

    ctx.overlayInteractiveMode = false;
    pushOverlayInteractionMode();

    const senderId = Number(event?.sender?.id || 0);
    if (
      ctx.plannerOverlayWindow &&
      !ctx.plannerOverlayWindow.isDestroyed() &&
      senderId === ctx.plannerOverlayWindow.webContents.id
    ) {
      plannerWindowsController.hideOverlayWindow();
      return;
    }

    rewardWindowsController.hideOverlayWindow();
  });

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
      if (typeof slug === "string") {
        const cached = wfmStatsPrice.getCachedPriceBySlug(slug);
        if (cached != null) return cached;
        const snapshot = relicSelectionController.getSnapshotPrice(slug);
        if (snapshot != null) return snapshot;
      }
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
    } else if (rewardWindowsController.isOverlayWindowVisible()) {
      rewardWindowsController.hideOverlayWindow();
    } else {
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
      rewardWindowsController.showOverlayWindowInactive();
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
      if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) return;
      relicSelectionController.setDesktopFilters(rawFilters);
    },
  );
}
