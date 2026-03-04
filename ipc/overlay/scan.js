"use strict";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chooseBetterScanResult(currentBest, candidate) {
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

function createOverlayScanController(options) {
  const { log, rewardScanner, ctx, windows } = options;

  let rewardScanInFlight = false;

  async function runRewardScanWithRetries(triggerSource) {
    const startedAt = Date.now();
    let attempts = 0;
    let bestResult = null;

    while (attempts < SCAN_MAX_ATTEMPTS && Date.now() - startedAt < SCAN_RETRY_WINDOW_MS) {
      attempts += 1;

      let result;
      try {
        result = await rewardScanner.scanRewardsDetailed();
      } catch (err) {
        log.error(`[Trigger] scan attempt ${attempts} failed:`, err.message);
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

  async function dispatchRewardScan(source) {
    if (rewardScanInFlight) {
      log.log(`[Trigger] scan already running, ignored duplicate trigger (${source})`);
      return;
    }

    rewardScanInFlight = true;

    try {
      if (typeof rewardScanner.waitForRewardUiReady === "function") {
        const gate = await rewardScanner.waitForRewardUiReady({
          timeoutMs: UI_READY_GATE_TIMEOUT_MS,
          pollMs: UI_READY_GATE_POLL_MS,
          requiredHits: UI_READY_GATE_REQUIRED_HITS,
          scoreThreshold: UI_READY_GATE_SCORE_THRESHOLD,
        });

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

      const result = await runRewardScanWithRetries(source);
      const items = Array.isArray(result?.items) ? result.items.slice(0, MAX_REWARD_ITEMS) : [];

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
      log.error("[Trigger] scan pipeline error:", err.message);
      windows.sendOverlayEvent("relic-reward-items", []);
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    } finally {
      rewardScanInFlight = false;
    }
  }

  function onRelicRewardTrigger(source = "manual") {
    if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) return;

    windows.clearOverlayAutoHideTimer();
    windows.createOverlayWindow();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

    windows.positionOverlayWindow(windows.getAnchorMeta());
    windows.sendOverlayEvent("relic-reward-trigger");
    windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);

    void dispatchRewardScan(source);
  }

  return {
    dispatchRewardScan,
    onRelicRewardTrigger,
  };
}

module.exports = {
  createOverlayScanController,
};
