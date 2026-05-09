import type { NativeImage } from "electron";
import { normalizeErrorMessage } from "../../config/shared/errors";
import { RELIC_REWARD_ITEMS, RELIC_REWARD_TRIGGER } from "../../config/shared/ipcChannels";

const SCAN_RETRY_WINDOW_MS = 5_000;
const SCAN_RETRY_INTERVAL_MS = 450;
const SCAN_MAX_ATTEMPTS = 10;
const MAX_REWARD_ITEMS = 4;
const EELOG_REWARD_SCAN_DELAY_MS = 1_200;

const OVERLAY_AUTO_HIDE_SUCCESS_MS = 12_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 3_500;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

type RewardScanResult = {
  items?: unknown[];
  meta?: Record<string, unknown> | null;
  attempts?: number;
  elapsedMs?: number;
  timedOut?: boolean;
  triggerSource?: string;
};

type OverlayScanControllerOptions = {
  log: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  rewardScanner: {
    scanRewardsDetailed: (preCapture?: {
      image: NativeImage;
      sourceType: string | null;
      sourceName: string | null;
      sourceId: string | null;
      sourceDisplayId: string | null;
    } | null) => Promise<RewardScanResult | null>;
  };
  ctx: {
    overlaySettings: Record<string, unknown>;
    overlayWindow: import("electron").BrowserWindow | null;
  };
  windows: {
    setAnchorMeta: (meta: Record<string, unknown> | null) => void;
    getAnchorMeta: () => Record<string, unknown> | null;
    positionOverlayWindow: (meta: Record<string, unknown> | null) => void;
    sendOverlayEvent: (channel: string, payload?: unknown) => void;
    scheduleOverlayAutoHide: (delayMs: number) => void;
    clearOverlayAutoHideTimer: () => void;
    createOverlayWindow: (options?: { show?: boolean }) => void;
  };
  warframeStatus?: {
    getStatus: (options?: { force?: boolean }) => Promise<{
      isOpen: boolean;
      isFocused: boolean;
      focusedProcessName?: string | null;
      focusedDisplayId?: string | null;
    }>;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseBetterScanResult(
  currentBest: RewardScanResult | null,
  candidate: RewardScanResult | null | undefined,
): RewardScanResult | null {
  if (!candidate) return currentBest;
  if (!currentBest) return candidate;

  const currentCount = Array.isArray(currentBest.items) ? currentBest.items.length : 0;
  const candidateCount = Array.isArray(candidate.items) ? candidate.items.length : 0;
  if (candidateCount !== currentCount) {
    return candidateCount > currentCount ? candidate : currentBest;
  }

  const currentScore = Number(currentBest.meta?.score || 0);
  const candidateScore = Number(candidate.meta?.score || 0);
  return candidateScore > currentScore ? candidate : currentBest;
}

export function createOverlayScanController(options: OverlayScanControllerOptions) {
  const { log, rewardScanner, ctx, windows, warframeStatus } = options;

  let rewardScanInFlight = false;

  async function runRewardScanWithRetries(triggerSource: string): Promise<RewardScanResult> {
    const startedAt = Date.now();
    let attempts = 0;
    let bestResult: RewardScanResult | null = null;

    while (attempts < SCAN_MAX_ATTEMPTS && Date.now() - startedAt < SCAN_RETRY_WINDOW_MS) {
      attempts += 1;

      let result: RewardScanResult | null | undefined;
      try {
        result = await rewardScanner.scanRewardsDetailed();
      } catch (err) {
        log.error(`[Trigger] scan attempt ${attempts} failed:`, normalizeErrorMessage(err));
      }

      bestResult = chooseBetterScanResult(bestResult, result);

      const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
      if (itemCount > 0) {
        return {
          ...result,
          attempts,
          elapsedMs: Date.now() - startedAt,
          timedOut: false,
        };
      }

      const elapsed = Date.now() - startedAt;
      const remaining = SCAN_RETRY_WINDOW_MS - elapsed;
      if (remaining <= 0 || attempts >= SCAN_MAX_ATTEMPTS) {
        break;
      }

      await sleep(Math.min(SCAN_RETRY_INTERVAL_MS, remaining));
    }

    const fallback = bestResult || { items: [], meta: null };
    return {
      ...fallback,
      attempts,
      elapsedMs: Date.now() - startedAt,
      timedOut: true,
      triggerSource,
    };
  }

  async function dispatchRewardScan(source: string): Promise<void> {
    if (rewardScanInFlight) {
      log.log(`[Trigger] scan already running, ignored duplicate trigger (${source})`);
      return;
    }

    rewardScanInFlight = true;

    try {
      if (source === "eelog" && warframeStatus?.getStatus) {
        const status = await warframeStatus.getStatus();
        if (!status.isOpen) {
          log.log("[Trigger] skipped reward scan: Warframe is not open");
          windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
          windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
          return;
        }
        if (!status.isFocused) {
          log.log(
            `[Trigger] skipped reward scan: Warframe is not focused (${status.focusedProcessName || "unknown"})`,
          );
          if (!status.focusedDisplayId) {
            windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
            windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
            return;
          }
          windows.setAnchorMeta({ sourceDisplayId: status.focusedDisplayId });
        }
      }

      if (source === "eelog") {
        log.log(`[Trigger] waiting ${EELOG_REWARD_SCAN_DELAY_MS}ms before reward scan`);
        await sleep(EELOG_REWARD_SCAN_DELAY_MS);
      }

      const result = await runRewardScanWithRetries(source);
      const items = Array.isArray(result?.items) ? result.items.slice(0, MAX_REWARD_ITEMS) : [];

      if (source === "eelog" && items.length > 0) {
        windows.createOverlayWindow({ show: true });
      }

      if (result?.meta) {
        windows.setAnchorMeta(result.meta);
        windows.positionOverlayWindow(windows.getAnchorMeta());
      }

      if (items.length === 0 && result?.timedOut) {
        log.warn(
          `[Trigger] no reward items found after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
        );
      } else {
        log.log(
          `[Trigger] reward scan resolved in ${result.elapsedMs}ms after ${result.attempts} attempt(s); ` +
            `${items.length} item(s)`,
        );
      }

      windows.sendOverlayEvent(RELIC_REWARD_ITEMS, items);
      windows.scheduleOverlayAutoHide(
        items.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
      );
    } catch (err) {
      log.error("[Trigger] scan pipeline error:", normalizeErrorMessage(err));
      windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    } finally {
      rewardScanInFlight = false;
    }
  }

  function onRelicRewardTrigger(source = "manual"): void {
    if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) return;

    windows.clearOverlayAutoHideTimer();
    const showImmediately = source !== "eelog";
    windows.createOverlayWindow({ show: showImmediately });
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

    windows.positionOverlayWindow(windows.getAnchorMeta());
    if (showImmediately) {
      windows.sendOverlayEvent(RELIC_REWARD_TRIGGER);
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);
    }

    void dispatchRewardScan(source);
  }

  return {
    dispatchRewardScan,
    onRelicRewardTrigger,
  };
}
