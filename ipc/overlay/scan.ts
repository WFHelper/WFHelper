import type { NativeImage } from "electron";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../config/shared/componentNames";
import { normalizeErrorMessage } from "../../config/shared/errors";
import { pendingRecipeCounts, withoutFoundryPending } from "../../config/shared/foundryPending";
import { RELIC_REWARD_ITEMS, RELIC_REWARD_TRIGGER } from "../../config/shared/ipcChannels";
import { normalizeWfmSlug } from "../../config/shared/wfm";
import { REFERENCE_WARFRAME_UI_SCALE } from "../../config/runtime/overlaySettings";
import { resolveWarframeUiScale } from "../../services/eeLogPath";
import * as itemDatabase from "../../services/itemDatabase";
import { computeMasteryProgress } from "../../services/masteryHelper";
import { getWindowsOcrHealth } from "../../services/ocrServer";
import { sleep } from "../../services/sleep";

const SCAN_RETRY_WINDOW_MS = 5_000;
const SCAN_RETRY_INTERVAL_MS = 450;
const SCAN_MAX_ATTEMPTS = 10;
// Consecutive no-layout scans before the trigger is written off as a false one.
const NO_LAYOUT_MAX_ATTEMPTS = 3;
const MAX_REWARD_ITEMS = 4;
// Fixed delay from the "Got rewards" line to the capture, the value AlecaFrame uses;
// the cards are drawn and the card bars settle the count by then.
const EELOG_REWARD_SCAN_DELAY_MS = 650;
// A render signal older than this belongs to an earlier crack.
const RENDER_SIGNAL_LOG_WINDOW_MS = 5_000;

// Hide just before the 15s relic vote ends, anchored to the trigger timestamp.
const REWARD_VOTE_WINDOW_MS = 14_500;
// Omnia missions crack relics back-to-back mid-gameplay; a 14.5s card sits in
// the way. Hide sooner - the next crack redraws it anyway.
const OMNIA_REWARD_VOTE_WINDOW_MS = 10_000;
// Solo cracks have no squad vote - "Relic reward screen shut down" marks the
// real close, often 5-8s in. Grace keeps the card readable a beat longer.
const REWARD_CLOSE_GRACE_MS = 1_500;
// A close line arriving via lazy file flush describes a screen long gone.
const REWARD_CLOSE_STALE_MAX_MS = 5_000;
const OVERLAY_AUTO_HIDE_SUCCESS_MS = 8_500;
// The vote window is anchored to the trigger, so a slow scan would otherwise
// eat the reading time - never show the card for less than this.
const REWARD_MIN_VISIBLE_MS = 5_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 3_500;
// Keep the overlay visible while Warframe is unfocused.
const AUTO_HIDE_FOCUS_RECHECK_MS = 2_000;
const AUTO_HIDE_REFOCUS_GRACE_MS = 2_500;
const AUTO_HIDE_MAX_HOLD_MS = 90_000;
// Retry once when a fade leaves reward slots unread.
const PARTIAL_LAYOUT_BONUS_ATTEMPTS = 1;
// long enough to read the "Windows OCR missing" instructions
const OVERLAY_AUTO_HIDE_OCR_UNAVAILABLE_MS = 12_000;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

type RewardScanResult = {
  items?: unknown[];
  meta?: Record<string, unknown> | null;
  attempts?: number;
  elapsedMs?: number;
  timedOut?: boolean;
  triggerSource?: string;
  /** Set when the retries ended short of the counted cards, so nothing is shown. */
  partial?: { itemCount: number; cardCount: number };
};

type RewardItem = {
  name?: unknown;
  uniqueName?: unknown;
  urlName?: unknown;
  ducats?: unknown;
  [key: string]: unknown;
};

type SetPartProgress = {
  name: string;
  imageUrl: string | null;
  ownedCount: number;
  requiredCount: number;
  /** The part this reward actually is - bow grips and the like are hard to spot. */
  isReward: boolean;
  /** Its blueprint is in the foundry, so one is already on the way. */
  building: boolean;
};

type InventoryData = Record<string, unknown> | null;

type ItemEntry = NonNullable<ReturnType<typeof itemDatabase.lookupItem>>;

type OverlayScanControllerOptions = {
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  rewardScanner: {
    scanRewardsDetailed: (
      preCapture?: {
        image: NativeImage;
        sourceType: string | null;
        sourceName: string | null;
        sourceId: string | null;
        sourceDisplayId: string | null;
      } | null,
      scanOptions?: { warframeUiScale?: number },
    ) => Promise<RewardScanResult | null>;
  };
  ctx: {
    overlaySettings: Record<string, unknown>;
    overlayWindow: import("electron").BrowserWindow | null;
    currentInventoryData?: InventoryData;
    activeFissureTier?: string | null;
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

function finitePositiveInteger(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  return Math.floor(numberValue);
}

function resolveRewardUniqueName(item: RewardItem): string | null {
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const slug = typeof item.urlName === "string" ? normalizeWfmSlug(item.urlName) : null;
  const byDisplayName = itemDatabase.lookupItemByNameOrSlug(name, slug);
  if (byDisplayName) return byDisplayName.uniqueName;

  if (typeof item.uniqueName === "string" && itemDatabase.lookupItem(item.uniqueName)) {
    return item.uniqueName;
  }

  return null;
}

function componentRequiredCount(parent: ItemEntry | null, uniqueName: string | null): number {
  if (!parent || !uniqueName) return 1;
  const aliases = componentUniqueNameAliases(uniqueName);
  const component = (parent.components || []).find((entry) =>
    Boolean(entry.uniqueName && aliases.includes(entry.uniqueName)),
  );
  return finitePositiveInteger(component?.itemCount) ?? 1;
}

function isInFoundry(uniqueName: string | null | undefined, pending: Set<string>): boolean {
  if (!uniqueName || pending.size === 0) return false;
  return componentUniqueNameAliases(uniqueName).some((alias) => pending.has(alias));
}

function setProgress(
  parent: ItemEntry | null,
  ownedCounts: Map<string, number>,
  pending: Set<string>,
  rewardUniqueName: string | null,
): { owned: number; required: number; completeSets: number; parts: SetPartProgress[] } | null {
  if (!parent || !Array.isArray(parent.components) || parent.components.length === 0) return null;
  const rewardAliases = rewardUniqueName ? componentUniqueNameAliases(rewardUniqueName) : [];

  let owned = 0;
  let required = 0;
  let completeSets = Number.POSITIVE_INFINITY;
  const parts: SetPartProgress[] = [];

  for (const component of parent.components) {
    if (!component.uniqueName || component.tradable === false) continue;
    const needed = finitePositiveInteger(component.itemCount) ?? 1;
    const count = ownedComponentCount(component.uniqueName, ownedCounts);
    required += needed;
    owned += Math.min(count, needed);
    completeSets = Math.min(completeSets, Math.floor(count / needed));
    const componentEntry = itemDatabase.lookupItem(component.uniqueName);
    parts.push({
      name: component.name || componentEntry?.name || "Part",
      imageUrl: componentEntry?.imageUrl || null,
      ownedCount: count,
      requiredCount: needed,
      isReward: rewardAliases.includes(component.uniqueName),
      building: isInFoundry(component.uniqueName, pending),
    });
  }

  if (required <= 0) return null;
  return {
    owned,
    required,
    completeSets: Number.isFinite(completeSets) ? completeSets : 0,
    parts,
  };
}

// Mastered flags keyed by catalog uniqueName + lowercase name (the catalog
// dedups by name). Non-masterables (Forma, Kuva, ...) get no entry, so no chip.
function masteredByKey(inventoryData: InventoryData): Map<string, boolean> | null {
  if (!inventoryData) return null;
  const byKey = new Map<string, boolean>();
  for (const item of computeMasteryProgress(inventoryData).items) {
    const mastered = item.status === "mastered";
    byKey.set(item.uniqueName, mastered);
    byKey.set(item.name.toLowerCase(), mastered);
  }
  return byKey;
}

function buildOwnedCounts(inventoryData: InventoryData): Map<string, number> {
  if (!inventoryData) return new Map();
  const usable = withoutFoundryPending(inventoryData, itemDatabase.isReusableBlueprint);
  return aggregateComponentOwnership(usable);
}

function buildPendingBlueprints(inventoryData: InventoryData): Set<string> {
  if (!inventoryData) return new Set();
  return new Set(pendingRecipeCounts(inventoryData.PendingRecipes).keys());
}

function enrichRewardItems(items: unknown[], inventoryData: InventoryData): unknown[] {
  const ownedCounts = buildOwnedCounts(inventoryData);
  const pending = buildPendingBlueprints(inventoryData);
  const masteredMap = masteredByKey(inventoryData);

  return items.map((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return rawItem;
    const item = rawItem as RewardItem;
    const uniqueName = resolveRewardUniqueName(item);
    const entry = uniqueName ? itemDatabase.lookupItem(uniqueName) : null;
    const parentUniqueName = entry?.componentOf || null;
    const parent = parentUniqueName ? itemDatabase.lookupItem(parentUniqueName) : null;
    const parentName = parent?.name || null;
    const setName = parentName ? `${parentName} Set` : null;
    const partRequiredCount = componentRequiredCount(parent, uniqueName);
    const partOwnedCount = ownedComponentCount(uniqueName, ownedCounts);
    const progress = setProgress(parent, ownedCounts, pending, uniqueName);
    const ducats = finitePositiveInteger(item.ducats) ?? entry?.ducats ?? null;
    const mastered =
      masteredMap && parent && parentUniqueName
        ? (masteredMap.get(parentUniqueName) ??
          masteredMap.get(String(parent.name || "").toLowerCase()))
        : undefined;

    return {
      ...item,
      ...(uniqueName ? { uniqueName } : {}),
      ducats,
      partOwnedCount,
      partRequiredCount,
      ...(mastered === undefined ? {} : { mastered }),
      ...(isInFoundry(uniqueName, pending) ? { building: true } : {}),
      ...(progress
        ? {
            setOwnedCount: progress.owned,
            setRequiredCount: progress.required,
            completeSetCount: progress.completeSets,
            setParts: progress.parts,
          }
        : {}),
      ...(setName
        ? {
            setName,
            setUrlName: normalizeWfmSlug(setName),
          }
        : {}),
    };
  });
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
  let eelogTriggerAt = 0;
  let rewardUiSignalLoggedAt = 0;
  let rewardScreenClosedAt = 0;
  let autoHideFocusTimer: ReturnType<typeof setTimeout> | null = null;

  // "ProjectionRewardChoice.lua: Missing icon data!" fires while the reward
  // cards render. Logged only: a tester log then shows how late the game drew them.
  function notifyRewardUiReady(): void {
    const sinceTrigger = Date.now() - eelogTriggerAt;
    if (eelogTriggerAt <= 0 || sinceTrigger > RENDER_SIGNAL_LOG_WINDOW_MS) return;
    // The game repeats the line while the cards draw; the first signal of a
    // reward screen is the one that dates the render.
    if (rewardUiSignalLoggedAt === eelogTriggerAt) return;
    rewardUiSignalLoggedAt = eelogTriggerAt;
    log.info(`[Trigger] reward UI render signal ${sinceTrigger}ms after the trigger`);
  }

  function clearAutoHideFocusHold(): void {
    if (!autoHideFocusTimer) return;
    clearTimeout(autoHideFocusTimer);
    autoHideFocusTimer = null;
  }

  function scheduleRewardAutoHide(delayMs: number): void {
    clearAutoHideFocusHold();
    if (!warframeStatus?.getStatus) {
      windows.scheduleOverlayAutoHide(delayMs);
      return;
    }
    const holdDeadline = Date.now() + delayMs + AUTO_HIDE_MAX_HOLD_MS;
    let wasHeld = false;
    const check = async (): Promise<void> => {
      let isOpen = true;
      let isFocused = true;
      try {
        const status = await warframeStatus.getStatus();
        isOpen = status.isOpen;
        isFocused = status.isFocused;
      } catch {
        // Fall through to a plain hide.
      }
      if (!isOpen || Date.now() >= holdDeadline) {
        windows.scheduleOverlayAutoHide(250);
        return;
      }
      if (isFocused) {
        windows.scheduleOverlayAutoHide(wasHeld ? AUTO_HIDE_REFOCUS_GRACE_MS : 250);
        return;
      }
      if (!wasHeld) {
        wasHeld = true;
        log.info("[Trigger] reward overlay held open: Warframe unfocused at auto-hide time");
      }
      autoHideFocusTimer = setTimeout(() => {
        autoHideFocusTimer = null;
        void check();
      }, AUTO_HIDE_FOCUS_RECHECK_MS);
    };
    autoHideFocusTimer = setTimeout(() => {
      autoHideFocusTimer = null;
      void check();
    }, delayMs);
  }

  function rewardSuccessAutoHideDelay(source: string): number {
    if (source !== "eelog" || !eelogTriggerAt) return OVERLAY_AUTO_HIDE_SUCCESS_MS;
    // Screen already closed while the scan ran - show the minimum and go.
    if (rewardScreenClosedAt) return REWARD_MIN_VISIBLE_MS;
    const voteWindowMs =
      ctx.activeFissureTier === "omnia" ? OMNIA_REWARD_VOTE_WINDOW_MS : REWARD_VOTE_WINDOW_MS;
    return Math.max(REWARD_MIN_VISIBLE_MS, eelogTriggerAt + voteWindowMs - Date.now());
  }

  // Close after the reading floor. Only the first close belongs to this crack because
  // the mid-mission picker reuses ProjectionRewardChoice.lua.
  function notifyRewardScreenClosed(stalenessMs = 0): void {
    if (!eelogTriggerAt || stalenessMs > REWARD_CLOSE_STALE_MAX_MS) return;
    if (rewardScreenClosedAt) return;
    rewardScreenClosedAt = Date.now();
    if (rewardScanInFlight) return; // success path shortens its own delay
    const delay = Math.max(
      REWARD_CLOSE_GRACE_MS,
      eelogTriggerAt + REWARD_MIN_VISIBLE_MS - Date.now(),
    );
    log.info(`[Trigger] reward screen closed -> overlay hides in ${delay}ms`);
    scheduleRewardAutoHide(delay);
  }

  async function runRewardScanWithRetries(triggerSource: string): Promise<RewardScanResult> {
    const startedAt = Date.now();
    let attempts = 0;
    let noLayoutAttempts = 0;
    let partialAttempts = 0;
    let bestResult: RewardScanResult | null = null;

    while (attempts < SCAN_MAX_ATTEMPTS && Date.now() - startedAt < SCAN_RETRY_WINDOW_MS) {
      attempts += 1;

      let result: RewardScanResult | null | undefined;
      try {
        result = await rewardScanner.scanRewardsDetailed(null, {
          // Read from EE.cfg each attempt so a mid-session slider change in the
          // game applies immediately; the settings slider is the fallback and
          // becomes authoritative when the user turns auto-detection off.
          warframeUiScale:
            (ctx.overlaySettings.warframeUiScaleAuto !== false ? resolveWarframeUiScale() : null) ??
            (Number(ctx.overlaySettings.warframeUiScale) || REFERENCE_WARFRAME_UI_SCALE),
        });
      } catch (err) {
        log.error(`[Trigger] scan attempt ${attempts} failed:`, normalizeErrorMessage(err));
      }

      bestResult = chooseBetterScanResult(bestResult, result);

      const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
      if (itemCount > 0) {
        const layoutCount = Number(result?.meta?.layoutCount || 0);
        const slotCount = Number(result?.meta?.slotCount || 0);
        const cardCount = Number(result?.meta?.cardCount || 0);
        // A full 3-slot read is complete by geometry: those cards sit half a card
        // off the 4-card grid. The 1- and 2-card grids share their centres with
        // the 3- and 4-card ones, so a full read there can still be a wider
        // screen whose outer cards have not rendered yet and keeps the retry.
        const geometryComplete = slotCount === 3 && itemCount >= slotCount;
        // No layout data at all (text fallback, tests) means nothing to compare against.
        const layoutKnown = Math.max(slotCount, layoutCount) > 0;
        // The card bars settle the count outright; the geometry rules only
        // apply when the frame had to be searched.
        const partial =
          cardCount > 0
            ? itemCount < cardCount
            : layoutKnown && itemCount < MAX_REWARD_ITEMS && !geometryComplete;
        if (!partial || partialAttempts >= PARTIAL_LAYOUT_BONUS_ATTEMPTS) {
          const best = bestResult as RewardScanResult;
          // The bars counted more cards than were read and the retries are spent.
          // Showing the fuller partial would be a wrong set, so ship nothing and
          // keep the meta for the anchor.
          if (partial && cardCount > 0) {
            return {
              meta: best.meta ?? null,
              items: [],
              attempts,
              elapsedMs: Date.now() - startedAt,
              timedOut: false,
              partial: {
                itemCount: Array.isArray(best.items) ? best.items.length : 0,
                cardCount,
              },
            };
          }
          return {
            ...best,
            attempts,
            elapsedMs: Date.now() - startedAt,
            timedOut: false,
          };
        }
        partialAttempts += 1;
        log.info(
          `[Trigger] partial layout (${itemCount}/${cardCount || slotCount || layoutCount} slots) - one more attempt`,
        );
      }

      // The trigger lines also fire on plain pauses; no card layout = not the reward screen.
      noLayoutAttempts = Number(result?.meta?.layoutCount || 0) > 0 ? 0 : noLayoutAttempts + 1;
      if (noLayoutAttempts >= NO_LAYOUT_MAX_ATTEMPTS) {
        log.info(`[Trigger] no reward layout in ${attempts} attempt(s) - not the reward screen`);
        break;
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

  async function dispatchRewardScan(source: string, stalenessMs = 0): Promise<void> {
    if (rewardScanInFlight) {
      log.info(`[Trigger] scan already running, ignored duplicate trigger (${source})`);
      return;
    }

    rewardScanInFlight = true;
    clearAutoHideFocusHold();
    // Backdate by the log flush lag so the auto-hide tracks when the reward
    // screen actually appeared, not when the line finally reached us.
    if (source === "eelog") {
      eelogTriggerAt = Date.now() - stalenessMs;
      rewardScreenClosedAt = 0;
    }

    try {
      if (source === "eelog" && warframeStatus?.getStatus) {
        // Anchors the card to a monitor, so a cached poll could pick a stale one.
        const status = await warframeStatus.getStatus({ force: true });
        if (!status.isOpen) {
          log.info("[Trigger] skipped reward scan: Warframe is not open");
          windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
          windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
          return;
        }
        if (!status.isFocused) {
          const focusedName = status.focusedProcessName || "unknown";
          if (!status.focusedDisplayId) {
            log.info(`[Trigger] skipped reward scan: Warframe is not focused (${focusedName})`);
            windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
            windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
            return;
          }
          log.info(
            `[Trigger] Warframe not focused (${focusedName}) - scanning anyway, overlay follows the focused display`,
          );
        }
        // Without an anchor the card lands on whichever display holds the
        // cursor, which is the other monitor whenever WFHelper is open there.
        if (status.focusedDisplayId) {
          windows.setAnchorMeta({ sourceDisplayId: status.focusedDisplayId });
        }
      }

      if (source === "eelog") {
        // Measured from the trigger, so the lazy file flush and the status
        // refresh above both count against the delay instead of extending it.
        await sleep(Math.max(0, eelogTriggerAt + EELOG_REWARD_SCAN_DELAY_MS - Date.now()));
      }

      const result = await runRewardScanWithRetries(source);
      const items = Array.isArray(result?.items)
        ? enrichRewardItems(
            result.items.slice(0, MAX_REWARD_ITEMS),
            ctx.currentInventoryData ?? null,
          )
        : [];

      if (result?.meta) {
        windows.setAnchorMeta(result.meta);
        windows.positionOverlayWindow(windows.getAnchorMeta());
      }

      if (source === "eelog" && items.length > 0) {
        windows.createOverlayWindow({ show: true });
      }

      if (result?.partial) {
        log.warn(
          `[Trigger] gave up: ${result.partial.itemCount}/${result.partial.cardCount} counted cards ` +
            `after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
        );
      } else if (items.length === 0 && result?.timedOut) {
        log.warn(
          `[Trigger] no reward items found after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
        );
      } else {
        // elapsedMs starts after the fixed post-trigger delay; the trigger delta
        // is what a tester's stopwatch measures.
        const sinceTrigger =
          source === "eelog" && eelogTriggerAt > 0
            ? `, ${Date.now() - eelogTriggerAt}ms after the trigger`
            : "";
        log.info(
          `[Trigger] reward scan resolved in ${result.elapsedMs}ms after ${result.attempts} attempt(s)` +
            `${sinceTrigger}; ${items.length} item(s)`,
        );
      }

      // A give-up read some cards, so OCR works; the language-pack hint would mislead.
      const ocrHealth = items.length === 0 && !result?.partial ? getWindowsOcrHealth() : null;
      if (ocrHealth && !ocrHealth.available) {
        log.warn(
          `[Trigger] Windows OCR unavailable: ${ocrHealth.reason} - install a Windows OCR ` +
            `language pack (Windows Settings > Time & Language > Language), then restart WFHelper`,
        );
        windows.sendOverlayEvent(RELIC_REWARD_ITEMS, {
          items: [],
          failureReason: "ocr-unavailable",
        });
        windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_OCR_UNAVAILABLE_MS);
        return;
      }

      windows.sendOverlayEvent(RELIC_REWARD_ITEMS, items);
      if (items.length > 0 && source === "eelog") {
        scheduleRewardAutoHide(rewardSuccessAutoHideDelay(source));
      } else {
        windows.scheduleOverlayAutoHide(
          items.length > 0 ? rewardSuccessAutoHideDelay(source) : OVERLAY_AUTO_HIDE_FAILURE_MS,
        );
      }
    } catch (err) {
      log.error("[Trigger] scan pipeline error:", normalizeErrorMessage(err));
      windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    } finally {
      rewardScanInFlight = false;
    }
  }

  function onRelicRewardTrigger(source = "manual", stalenessMs = 0): void {
    if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) return;

    clearAutoHideFocusHold();
    windows.clearOverlayAutoHideTimer();
    const showImmediately = source !== "eelog";
    windows.createOverlayWindow({ show: showImmediately });
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

    windows.positionOverlayWindow(windows.getAnchorMeta());
    if (showImmediately) {
      windows.sendOverlayEvent(RELIC_REWARD_TRIGGER);
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);
    }

    void dispatchRewardScan(source, stalenessMs);
  }

  return {
    dispatchRewardScan,
    onRelicRewardTrigger,
    notifyRewardUiReady,
    notifyRewardScreenClosed,
  };
}
