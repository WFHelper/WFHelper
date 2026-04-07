import { createRuntimeRequire } from "../runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 2);
const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const SCAN_RETRY_WINDOW_MS = 5_000;
const SCAN_RETRY_INTERVAL_MS = 450;
const SCAN_MAX_ATTEMPTS = 10;
const MAX_REWARD_ITEMS = 4;

const OVERLAY_AUTO_HIDE_SUCCESS_MS = 12_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 3_500;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

const UI_READY_GATE_TIMEOUT_MS = 2_200;
const UI_READY_GATE_POLL_MS = 120;
const UI_READY_GATE_REQUIRED_HITS = 2;
const UI_READY_GATE_SCORE_THRESHOLD = 0.58;

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
    scanRewardsDetailed: (preCapture?: { image: any; sourceType: string | null; sourceName: string | null; sourceId: string | null; sourceDisplayId: string | null } | null) => Promise<RewardScanResult | null>;
    waitForRewardUiReady?: (options: {
      timeoutMs: number;
      pollMs: number;
      requiredHits: number;
      scoreThreshold: number;
    }) => Promise<
      | {
          ready?: boolean;
          elapsedMs?: number;
          attempts?: number;
          lastScreenshot?: any;
          best?: {
            sourceDisplayId?: string | null;
            bandBottomRatio?: number;
            score?: number;
          };
        }
      | undefined
    >;
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

  async function runRewardScanWithRetries(triggerSource: string, gatePre?: any): Promise<RewardScanResult> {
    const startedAt = Date.now();
    let attempts = 0;
    let bestResult: RewardScanResult | null = null;
    let gatePreUsed = false;

    while (attempts < SCAN_MAX_ATTEMPTS && Date.now() - startedAt < SCAN_RETRY_WINDOW_MS) {
      attempts += 1;

      // F2: use gate pre-captured screenshot on first attempt only; fresh capture on retries
      const preCapture = !gatePreUsed && gatePre ? gatePre : undefined;
      if (preCapture) gatePreUsed = true;

      let result: RewardScanResult | null | undefined;
      try {
        result = await rewardScanner.scanRewardsDetailed(preCapture);
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
          windows.sendOverlayEvent("relic-reward-items", []);
          windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
          return;
        }
        if (!status.isFocused) {
          log.log(
            `[Trigger] skipped reward scan: Warframe is not focused (${status.focusedProcessName || "unknown"})`,
          );
          if (!status.focusedDisplayId) {
            windows.sendOverlayEvent("relic-reward-items", []);
            windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
            return;
          }
          windows.setAnchorMeta({ sourceDisplayId: status.focusedDisplayId });
        }
      }

      // F2: store the gate's last screenshot so we can pass it as preCapture
      let gatePre: any = undefined;
      if (typeof rewardScanner.waitForRewardUiReady === "function") {
        const gate = await rewardScanner.waitForRewardUiReady({
          timeoutMs: UI_READY_GATE_TIMEOUT_MS,
          pollMs: UI_READY_GATE_POLL_MS,
          requiredHits: UI_READY_GATE_REQUIRED_HITS,
          scoreThreshold: UI_READY_GATE_SCORE_THRESHOLD,
        });

        gatePre = gate?.lastScreenshot ?? undefined;

        if (gate?.best && Number.isFinite(gate.best.bandBottomRatio)) {
          windows.setAnchorMeta({
            sourceDisplayId: gate.best.sourceDisplayId || null,
            bandBottomRatio: gate.best.bandBottomRatio,
          });
          windows.positionOverlayWindow(windows.getAnchorMeta());
        }

        if (gate?.ready) {
          log.log(
            "[Trigger] UI-ready gate passed in " +
              gate.elapsedMs +
              "ms (" +
              gate.attempts +
              " samples, score " +
              Number(gate.best?.score || 0).toFixed(3) +
              ")",
          );
        } else {
          log.log(
            "[Trigger] UI-ready gate timed out after " +
              (gate?.elapsedMs ?? 0) +
              "ms; continuing scan pipeline (best score " +
              Number(gate?.best?.score || 0).toFixed(3) +
              ")",
          );
        }
      }

      const result = await runRewardScanWithRetries(source, gatePre);
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

      windows.sendOverlayEvent("relic-reward-items", items);
      windows.scheduleOverlayAutoHide(
        items.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
      );
    } catch (err) {
      log.error("[Trigger] scan pipeline error:", normalizeErrorMessage(err));
      windows.sendOverlayEvent("relic-reward-items", []);
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
      windows.sendOverlayEvent("relic-reward-trigger");
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);
    }

    void dispatchRewardScan(source);
  }

  return {
    dispatchRewardScan,
    onRelicRewardTrigger,
  };
}
