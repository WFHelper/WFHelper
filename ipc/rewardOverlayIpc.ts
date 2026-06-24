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
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";

import * as relicService from "../services/relicService";
import * as itemDatabase from "../services/itemDatabase";
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
  OVERLAY_CLOSE, OVERLAY_GET_RELIC_ITEMS, OVERLAY_GET_PRICE,
  TOGGLE_OVERLAY, SIMULATE_RELIC_TRIGGER, OVERLAY_PUSH_RELIC_FILTERS,
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

import { BrowserWindow, screen, app } from "electron";
import path from "node:path";
import fs from "node:fs";

const APP_ROOT = app.getAppPath();
const OVERLAY_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
// Prices (and ducat meta) now live in the snapshot cache - price-cache.json is no longer written.
const PRICE_CACHE_FILE = path.join(app.getPath("userData"), "snapshot-cache.json");


export const rewardWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
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
  }
}

// Keep overlay windows attached to Warframe's z-order instead of floating above other apps.
const overlayZOrderInterval = setInterval(async () => {
  try {
    const status = await warframeStatus.getStatus();
    syncOverlayWindowZOrder(ctx.overlayWindow, status.isFocused);
    syncOverlayWindowZOrder(ctx.plannerOverlayWindow, status.isFocused);
  } catch {
    // ignore
  }
}, 2000);

app.on("before-quit", () => {
  clearInterval(overlayZOrderInterval);
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



export function onRelicRewardTrigger(
  source: string,
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
  scanController.onRelicRewardTrigger(source);
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


export function register(pushOverlayInteractionMode: () => void, pushOverlayThemeVars: () => void): void {
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
    const db = relicService.getRelicDatabase();
    const seen = new Map<
      string,
      {
        name: string;
        uniqueName: string | null;
        urlName: string | null;
        rarity: string;
        ducats: number | null;
      }
    >();
    for (const group of Object.values(db.groups)) {
      if (!group.qualities) continue;
      for (const qualData of Object.values(group.qualities)) {
        if (!qualData?.rewards) continue;
        for (const reward of qualData.rewards) {
          if (reward.name && !seen.has(reward.name)) {
            const resolved = itemDatabase.lookupItemByNameOrSlug(reward.name, reward.urlName);
            const dbEntry =
              resolved?.item ||
              (reward.uniqueName ? itemDatabase.lookupItem(reward.uniqueName) : null);
            seen.set(reward.name, {
              name: reward.name,
              uniqueName: resolved?.uniqueName || reward.uniqueName || null,
              urlName: reward.urlName || null,
              rarity: reward.rarity || "Common",
              ducats: reward.ducats ?? dbEntry?.ducats ?? null,
            });
          }
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  handleAuthorized(OVERLAY_GET_PRICE, assertOverlayRendererSender, async (_event, slug: unknown) => {
    return wfmStatsPrice.fetchPriceBySlug(slug);
  });

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
      pushOverlayInteractionMode,
      pushOverlayThemeVars,
      async () => {},
    );
  });

  onAuthorized(OVERLAY_PUSH_RELIC_FILTERS, assertMainRendererSender, (_event, rawFilters: unknown) => {
    if (!rawFilters || typeof rawFilters !== "object") return;
    const filters = rawFilters as Record<string, unknown>;
    relicSelectionController.setDesktopFilters({
      squadSize: typeof filters.squadSize === "number" ? filters.squadSize : undefined,
      tierFilter: typeof filters.tierFilter === "string" ? filters.tierFilter : null,
    });
  });
}
