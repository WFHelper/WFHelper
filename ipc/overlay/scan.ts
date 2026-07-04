import type { NativeImage } from "electron";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import { componentUniqueNameAliases } from "../../config/shared/componentNames";
import { normalizeErrorMessage } from "../../config/shared/errors";
import { RELIC_REWARD_ITEMS, RELIC_REWARD_TRIGGER } from "../../config/shared/ipcChannels";
import { normalizeWfmSlug } from "../../config/shared/wfm";
import * as itemDatabase from "../../services/itemDatabase";
import { sleep } from "../../services/rewardScannerUtils";

const SCAN_RETRY_WINDOW_MS = 5_000;
const SCAN_RETRY_INTERVAL_MS = 450;
const SCAN_MAX_ATTEMPTS = 10;
const MAX_REWARD_ITEMS = 4;
const EELOG_REWARD_SCAN_DELAY_MS = 1_200;

// The in-game relic reward vote runs ~15s; the overlay hides when it ends.
// Was 10s, which hid the overlay ~5s before the selection actually closed.
const REWARD_VOTE_WINDOW_MS = 15_000;
const OVERLAY_AUTO_HIDE_SUCCESS_MS = 8_500;
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
    ) => Promise<RewardScanResult | null>;
  };
  ctx: {
    overlaySettings: Record<string, unknown>;
    overlayWindow: import("electron").BrowserWindow | null;
    currentInventoryData?: InventoryData;
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

function setProgress(
  parent: ItemEntry | null,
  ownedCounts: Map<string, number>,
): { owned: number; required: number; completeSets: number; parts: SetPartProgress[] } | null {
  if (!parent || !Array.isArray(parent.components) || parent.components.length === 0) return null;

  let owned = 0;
  let required = 0;
  let completeSets = Number.POSITIVE_INFINITY;
  const parts: SetPartProgress[] = [];

  for (const component of parent.components) {
    if (!component.uniqueName || component.tradable === false) continue;
    const needed = finitePositiveInteger(component.itemCount) ?? 1;
    const count = ownedCounts.get(component.uniqueName) || 0;
    required += needed;
    owned += Math.min(count, needed);
    completeSets = Math.min(completeSets, Math.floor(count / needed));
    const componentEntry = itemDatabase.lookupItem(component.uniqueName);
    parts.push({
      name: component.name || componentEntry?.name || "Part",
      imageUrl: componentEntry?.imageUrl || null,
      ownedCount: count,
      requiredCount: needed,
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

function buildOwnedCounts(inventoryData: InventoryData): Map<string, number> {
  if (!inventoryData) return new Map();
  return aggregateComponentOwnership(
    inventoryData.MiscItems,
    inventoryData.Recipes,
    inventoryData.PendingRecipes,
  );
}

function enrichRewardItems(items: unknown[], inventoryData: InventoryData): unknown[] {
  const ownedCounts = buildOwnedCounts(inventoryData);

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
    const partOwnedCount = uniqueName ? ownedCounts.get(uniqueName) || 0 : 0;
    const progress = setProgress(parent, ownedCounts);
    const ducats = finitePositiveInteger(item.ducats) ?? entry?.ducats ?? null;

    return {
      ...item,
      ...(uniqueName ? { uniqueName } : {}),
      ducats,
      partOwnedCount,
      partRequiredCount,
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

function rewardSuccessAutoHideDelay(source: string, result: RewardScanResult | null): number {
  if (source !== "eelog") return OVERLAY_AUTO_HIDE_SUCCESS_MS;

  const elapsedMs = Number(result?.elapsedMs || 0);
  const elapsedSinceTrigger = EELOG_REWARD_SCAN_DELAY_MS + (Number.isFinite(elapsedMs) ? elapsedMs : 0);
  return Math.max(2_500, REWARD_VOTE_WINDOW_MS - elapsedSinceTrigger);
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
      log.info(`[Trigger] scan already running, ignored duplicate trigger (${source})`);
      return;
    }

    rewardScanInFlight = true;

    try {
      if (source === "eelog" && warframeStatus?.getStatus) {
        const status = await warframeStatus.getStatus();
        if (!status.isOpen) {
          log.info("[Trigger] skipped reward scan: Warframe is not open");
          windows.sendOverlayEvent(RELIC_REWARD_ITEMS, []);
          windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
          return;
        }
        if (!status.isFocused) {
          log.info(
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
        log.info(`[Trigger] waiting ${EELOG_REWARD_SCAN_DELAY_MS}ms before reward scan`);
        await sleep(EELOG_REWARD_SCAN_DELAY_MS);
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

      if (items.length === 0 && result?.timedOut) {
        log.warn(
          `[Trigger] no reward items found after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
        );
      } else {
        log.info(
          `[Trigger] reward scan resolved in ${result.elapsedMs}ms after ${result.attempts} attempt(s); ` +
            `${items.length} item(s)`,
        );
      }

      windows.sendOverlayEvent(RELIC_REWARD_ITEMS, items);
      windows.scheduleOverlayAutoHide(
        items.length > 0
          ? rewardSuccessAutoHideDelay(source, result)
          : OVERLAY_AUTO_HIDE_FAILURE_MS,
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
