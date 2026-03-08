"use strict";

export {};

import { createRuntimeRequire } from "../runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 2);
const sharedNumeric = requireRuntime<{
  toFiniteOr: (value: unknown, fallback: number) => number;
  clampNumber: (value: number, min: number, max: number) => number;
}>("config/shared/numeric.cjs");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { toFiniteOr, clampNumber } = sharedNumeric;

const RECOMMENDATION_ROW_LIMIT = 6;
const RECOMMENDATION_SQUAD_SIZE = 4;
const RECOMMENDATION_CACHE_TTL_MS = 10_000;
const MIN_EELOG_TRIGGER_GAP_MS = 900;
const ERA_DETECTION_TIMEOUT_MS = 1500;
const REOPEN_SUPPRESS_AFTER_CLOSE_MS = 3_000;

const OVERLAY_AUTO_HIDE_SUCCESS_MS = 18_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 4_500;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

const QUALITY_ORDER = Object.freeze(["radiant", "flawless", "exceptional", "intact"]);
const QUALITY_LABEL = Object.freeze({
  intact: "Intact",
  exceptional: "Exceptional",
  flawless: "Flawless",
  radiant: "Radiant",
});

const PRICE_OK_TTL_MS = 12 * 60 * 60 * 1000;
const PRICE_NODATA_TTL_MS = 6 * 60 * 60 * 1000;

type Reward = {
  urlName?: string | null;
  chance?: number;
  ducats?: number | null;
  rarity?: string | null;
};

type QualityData = {
  rewards?: Reward[];
};

type RelicGroup = {
  key: string;
  name: string;
  tier?: string;
  qualities?: Record<string, QualityData | undefined>;
};

type OwnedCountRow = {
  intact: number;
  exceptional: number;
  flawless: number;
  radiant: number;
};

type RecommendationRow = {
  label: string;
  relicName: string;
  quality: string;
  count: number;
  platEv: number | null;
  ducatEv: number | null;
};

type OverlayRecommendationControllerOptions = {
  log: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  ctx: {
    overlaySettings: Record<string, unknown>;
    currentInventoryData: Record<string, unknown> | null;
    overlayDismissedUntilMs?: number;
  };
  windows: {
    createOverlayWindow: () => void;
    clearOverlayAutoHideTimer: () => void;
    scheduleOverlayAutoHide: (delayMs: number) => void;
    sendOverlayEvent: (channel: string, payload?: unknown) => void;
    positionOverlayWindow: (meta: Record<string, unknown> | null) => void;
    getAnchorMeta: () => Record<string, unknown> | null;
    setAnchorMeta: (meta: Record<string, unknown> | null) => void;
  };
  relicService: {
    getRelicDatabase: () => {
      groups: Record<string, RelicGroup>;
      byUniqueName: Record<string, { groupKey: string; quality: keyof OwnedCountRow }>;
    };
  };
  rewardScanner: {
    captureSourceMeta?: (options?: { preferredDisplayId?: string | null }) => Promise<{
      sourceType?: string | null;
      sourceDisplayId?: string | null;
      sourceName?: string | null;
      sourceId?: string | null;
    } | null>;
    detectRelicSelectionEra?: (options?: {
      timeoutMs?: number;
      preferredDisplayId?: string | null;
    }) => Promise<{
      era?: string | null;
      confidence?: number;
      textPreview?: string;
      elapsedMs?: number;
      sourceType?: string | null;
      sourceName?: string | null;
      sourceDisplayId?: string | null;
      sourceId?: string | null;
      candidateId?: string | null;
    }>;
  };
  wfmStatsPrice: {
    getCachedPriceBySlug?: (slug: string) => number | null;
  };
  warframeStatus?: {
    getStatus: (options?: { force?: boolean }) => Promise<{
      isOpen: boolean;
      isFocused: boolean;
      focusedProcessName?: string | null;
      focusedDisplayId?: string | null;
    }>;
  };
  fs: typeof import("node:fs");
  cacheFilePath: string;
};

function normalizeSlug(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeEra(value: unknown): string | null {
  const low = String(value || "")
    .trim()
    .toLowerCase();
  if (!low) return null;
  if (low.includes("requiem")) return "requiem";
  if (low.includes("lith")) return "lith";
  if (low.includes("meso")) return "meso";
  if (low.includes("neo")) return "neo";
  if (low.includes("axi")) return "axi";
  return null;
}

function qualityCountsRow(): OwnedCountRow {
  return {
    intact: 0,
    exceptional: 0,
    flawless: 0,
    radiant: 0,
  };
}

function parseOwnedRelicCounts(
  inventoryData: Record<string, unknown> | null,
  byUniqueName: Record<string, { groupKey: string; quality: keyof OwnedCountRow }>,
): Record<string, OwnedCountRow> {
  const owned: Record<string, OwnedCountRow> = {};
  if (!inventoryData) return owned;

  const countedByItemType = new Map<string, number>();

  const addEntries = (entries: unknown, allowOverwriteExisting = false): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as { ItemType?: string; ItemCount?: number };
      if (!raw.ItemType) continue;

      const info = byUniqueName[raw.ItemType];
      if (!info) continue;

      const count = Math.max(0, Math.floor(toFiniteOr(raw.ItemCount, 1) || 1));
      if (countedByItemType.has(raw.ItemType)) {
        if (allowOverwriteExisting) {
          const existing = countedByItemType.get(raw.ItemType) || 0;
          countedByItemType.set(raw.ItemType, Math.max(existing, count));
        }
        continue;
      }

      countedByItemType.set(raw.ItemType, count);
    }
  };

  addEntries(inventoryData.LevelKeys, true);
  addEntries(inventoryData.MiscItems);
  addEntries((inventoryData as Record<string, unknown>).Recipes);

  if (countedByItemType.size === 0) {
    for (const value of Object.values(inventoryData)) {
      addEntries(value);
    }
  }

  for (const [itemType, count] of countedByItemType) {
    const info = byUniqueName[itemType];
    if (!info) continue;

    if (!owned[info.groupKey]) {
      owned[info.groupKey] = qualityCountsRow();
    }
    owned[info.groupKey][info.quality] += count;
  }

  return owned;
}

function computeSquadExpected(
  rewards: Array<{ chance: number }>,
  values: Array<number | null>,
  squadSize: number,
): number {
  const items = rewards.map((reward, index) => ({
    prob: clampNumber(toFiniteOr(reward?.chance, 0) / 100, 0, 1),
    value: values[index] ?? 0,
  }));

  if (squadSize <= 1) {
    return items.reduce((sum, item) => sum + item.prob * item.value, 0);
  }

  const sorted = [...items].sort((a, b) => a.value - b.value);
  const grouped: Array<{ value: number; prob: number }> = [];
  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.value === item.value) {
      last.prob += item.prob;
    } else {
      grouped.push({ value: item.value, prob: item.prob });
    }
  }

  let ev = 0;
  let cdfPrev = 0;
  for (const groupedItem of grouped) {
    const cdfCur = Math.min(1, cdfPrev + groupedItem.prob);
    ev += groupedItem.value * (Math.pow(cdfCur, squadSize) - Math.pow(cdfPrev, squadSize));
    cdfPrev = cdfCur;
  }
  return ev;
}

function isPriceEntryFresh(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const raw = entry as { status?: unknown; timestamp?: unknown };
  const status = String(raw.status || "").toLowerCase();
  const timestamp = toFiniteOr(raw.timestamp, 0);
  if (!timestamp || !status) return false;
  const ttl = status === "ok" ? PRICE_OK_TTL_MS : PRICE_NODATA_TTL_MS;
  return Date.now() - timestamp < ttl;
}

function loadPersistedPriceMedianMap(
  fs: typeof import("node:fs"),
  cacheFilePath: string,
): Map<string, number> {
  const prices = new Map<string, number>();

  try {
    if (!fs.existsSync(cacheFilePath)) return prices;
    const raw = fs.readFileSync(cacheFilePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return prices;

    for (const [slug, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isPriceEntryFresh(entry)) continue;
      const median = toFiniteOr((entry as { median?: unknown }).median, NaN);
      if (!Number.isFinite(median) || median <= 0) continue;
      prices.set(normalizeSlug(slug), median);
    }
  } catch {
    return prices;
  }

  return prices;
}

function getCacheFileMtimeMs(fs: typeof import("node:fs"), cacheFilePath: string): number {
  try {
    if (!fs.existsSync(cacheFilePath)) return 0;
    const stat = fs.statSync(cacheFilePath);
    const mtimeMs = toFiniteOr((stat as { mtimeMs?: number }).mtimeMs, 0);
    return Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0;
  } catch {
    return 0;
  }
}

function pickBestOwnedQuality(
  group: RelicGroup,
  ownedRow: OwnedCountRow,
  priceLookup: (slug: string) => number | null,
): RecommendationRow | null {
  let best: RecommendationRow | null = null;

  for (const quality of QUALITY_ORDER) {
    const count = ownedRow[quality] || 0;
    if (count <= 0) continue;

    const rewards = group.qualities?.[quality]?.rewards || [];
    if (rewards.length === 0) continue;

    const normalizedRewards = rewards.map((reward) => ({
      chance: clampNumber(toFiniteOr(reward?.chance, 0), 0, 100),
      ducats: reward?.ducats,
      urlName: reward?.urlName,
      rarity: reward?.rarity,
    }));

    const platValues = normalizedRewards.map((reward) => {
      const slug = normalizeSlug(reward?.urlName);
      return slug ? priceLookup(slug) : null;
    });
    const ducatValues = normalizedRewards.map((reward) => {
      const n = toFiniteOr(reward?.ducats, NaN);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
    });

    const hasAnyPlat = platValues.some((value) => value != null);
    const hasAnyDucat = ducatValues.some((value) => value != null);
    if (!hasAnyPlat && !hasAnyDucat) continue;

    const platEv = hasAnyPlat
      ? computeSquadExpected(normalizedRewards, platValues, RECOMMENDATION_SQUAD_SIZE)
      : null;
    const ducatEv = hasAnyDucat
      ? computeSquadExpected(normalizedRewards, ducatValues, RECOMMENDATION_SQUAD_SIZE)
      : null;

    const row: RecommendationRow = {
      label: `${count}x ${group.name} ${QUALITY_LABEL[quality]}`,
      relicName: group.name,
      quality,
      count,
      platEv,
      ducatEv,
    };

    if (!best) {
      best = row;
      continue;
    }

    const bestPlat = best.platEv ?? -1;
    const nextPlat = row.platEv ?? -1;
    if (nextPlat !== bestPlat) {
      if (nextPlat > bestPlat) best = row;
      continue;
    }

    const bestDucat = best.ducatEv ?? -1;
    const nextDucat = row.ducatEv ?? -1;
    if (nextDucat > bestDucat) best = row;
  }

  return best;
}

function toStableOwnedFingerprint(owned: Record<string, OwnedCountRow>): string {
  const rows = Object.entries(owned)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([groupKey, counts]) =>
        `${groupKey}:${counts.intact}|${counts.exceptional}|${counts.flawless}|${counts.radiant}`,
    );
  return rows.join(";");
}

export function createRelicSelectionController(options: OverlayRecommendationControllerOptions) {
  const {
    log,
    ctx,
    windows,
    relicService,
    rewardScanner,
    wfmStatsPrice,
    fs,
    cacheFilePath,
  } = options;

  let inFlight = false;
  let activeScanToken = 0;
  let lastEelogTriggerAt = 0;
  let lastKnownGameDisplayId: string | null = null;
  let cache: {
    key: string;
    rows: RecommendationRow[];
    era: string | null;
    totalOwnedCount: number;
    ts: number;
  } | null = null;
  let persistedPriceMedianCache: {
    mtimeMs: number;
    prices: Map<string, number>;
  } | null = null;

  function getPersistedPriceMedianMapCached(): Map<string, number> {
    const mtimeMs = getCacheFileMtimeMs(fs, cacheFilePath);
    if (persistedPriceMedianCache && persistedPriceMedianCache.mtimeMs === mtimeMs) {
      return persistedPriceMedianCache.prices;
    }

    const prices = loadPersistedPriceMedianMap(fs, cacheFilePath);
    persistedPriceMedianCache = {
      mtimeMs,
      prices,
    };
    return prices;
  }

  function buildRecommendations(
    era: string | null,
  ): { rows: RecommendationRow[]; totalOwnedCount: number } {
    const db = relicService.getRelicDatabase();
    const groups = Object.values(db.groups || {}) as RelicGroup[];
    const owned = parseOwnedRelicCounts(ctx.currentInventoryData, db.byUniqueName || {});

    const cacheKey = `${era || "all"}|${toStableOwnedFingerprint(owned)}`;
    if (cache && cache.key === cacheKey && Date.now() - cache.ts < RECOMMENDATION_CACHE_TTL_MS) {
      return { rows: cache.rows, totalOwnedCount: cache.totalOwnedCount };
    }

    const persistedPrices = getPersistedPriceMedianMapCached();

    const getPrice = (slug: string): number | null => {
      const normalized = normalizeSlug(slug);
      if (!normalized) return null;

      if (persistedPrices.has(normalized)) {
        return persistedPrices.get(normalized) || null;
      }

      if (typeof wfmStatsPrice.getCachedPriceBySlug === "function") {
        const cached = wfmStatsPrice.getCachedPriceBySlug(normalized);
        if (typeof cached === "number" && Number.isFinite(cached) && cached > 0) {
          return cached;
        }
      }

      return null;
    };

    let totalOwnedCount = 0;
    const rows: RecommendationRow[] = [];
    for (const group of groups) {
      const groupEra = normalizeEra(group.tier);
      if (era && groupEra !== era) continue;

      const ownedRow = owned[group.key];
      if (!ownedRow) continue;

      const groupTotal =
        (ownedRow.intact || 0) +
        (ownedRow.exceptional || 0) +
        (ownedRow.flawless || 0) +
        (ownedRow.radiant || 0);
      totalOwnedCount += groupTotal;

      const best = pickBestOwnedQuality(group, ownedRow, getPrice);
      if (best) rows.push(best);
    }

    rows.sort((a, b) => {
      const aPlat = a.platEv ?? -1;
      const bPlat = b.platEv ?? -1;
      if (bPlat !== aPlat) return bPlat - aPlat;

      const aDucat = a.ducatEv ?? -1;
      const bDucat = b.ducatEv ?? -1;
      if (bDucat !== aDucat) return bDucat - aDucat;

      return a.label.localeCompare(b.label);
    });

    const sliced = rows.slice(0, RECOMMENDATION_ROW_LIMIT);
    cache = {
      key: cacheKey,
      rows: sliced,
      era,
      totalOwnedCount,
      ts: Date.now(),
    };

    return { rows: sliced, totalOwnedCount };
  }

  function sendFallbackRows(scanToken: number, source: string): void {
    const startedAt = Date.now();
    try {
      const { rows, totalOwnedCount } = buildRecommendations(null);
      if (scanToken !== activeScanToken) return;

      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era: null,
        rows,
        totalOwnedCount,
        detection: {
          confidence: 0,
          textPreview: "",
          elapsedMs: 0,
        },
      });

      if (rows.length > 0) {
        windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_SUCCESS_MS);
      }

      log.log(
        `[RelicSelection] fallback rows sent count=${rows.length} elapsed=${Date.now() - startedAt}ms token=${scanToken}`,
      );
    } catch (err) {
      if (scanToken !== activeScanToken) return;
      log.warn("[RelicSelection] fallback rows failed:", normalizeErrorMessage(err));
    }
  }

  async function runRefinement(
    scanToken: number,
    source: string,
    preferredDisplayIdInitial: string | null,
  ): Promise<void> {
    const refineStartedAt = Date.now();
    let preferredDisplayId = preferredDisplayIdInitial;

    try {
      if (typeof rewardScanner.captureSourceMeta === "function") {
        const captureMetaStartedAt = Date.now();
        try {
          const sourceMeta = await rewardScanner.captureSourceMeta({ preferredDisplayId });
          if (scanToken !== activeScanToken) return;
          log.log(
            `[RelicSelection] source meta elapsed=${Date.now() - captureMetaStartedAt}ms source=${String(
              sourceMeta?.sourceType || "unknown",
            )}:${String(sourceMeta?.sourceName || sourceMeta?.sourceId || "unknown")} display=${String(
              sourceMeta?.sourceDisplayId || "unknown",
            )}`,
          );
          if (sourceMeta?.sourceDisplayId) {
            windows.setAnchorMeta({ sourceDisplayId: sourceMeta.sourceDisplayId });
            preferredDisplayId = String(sourceMeta.sourceDisplayId);
            lastKnownGameDisplayId = preferredDisplayId;
            windows.positionOverlayWindow(windows.getAnchorMeta());
          }
        } catch {
          // non-critical, detection flow will still run
        }
      }

      const eraDetectStartedAt = Date.now();
      const eraDetection =
        typeof rewardScanner.detectRelicSelectionEra === "function"
          ? await rewardScanner.detectRelicSelectionEra({
              timeoutMs: ERA_DETECTION_TIMEOUT_MS,
              preferredDisplayId,
            })
          : null;

      if (scanToken !== activeScanToken) return;

      log.log(`[RelicSelection] era detection elapsed=${Date.now() - eraDetectStartedAt}ms`);

      if (eraDetection?.sourceDisplayId) {
        windows.setAnchorMeta({ sourceDisplayId: eraDetection.sourceDisplayId });
        lastKnownGameDisplayId = String(eraDetection.sourceDisplayId);
        windows.positionOverlayWindow(windows.getAnchorMeta());
      }

      const era = normalizeEra(eraDetection?.era || null);
      const eraConfidence = toFiniteOr(eraDetection?.confidence, 0);
      const shouldApplyEra = Boolean(era && eraConfidence >= 0.9);

      log.log(
        `[RelicSelection] era detection: era=${era || "none"} conf=${toFiniteOr(eraDetection?.confidence, 0).toFixed(3)} ` +
          `source=${String(eraDetection?.sourceType || "unknown")}:${String(eraDetection?.sourceName || eraDetection?.sourceId || "unknown")} ` +
          `display=${String(eraDetection?.sourceDisplayId || "unknown")} ` +
          `candidate=${String(eraDetection?.candidateId || "-")} preview="${String(eraDetection?.textPreview || "")}"`,
      );

      const { rows, totalOwnedCount } = buildRecommendations(shouldApplyEra ? era : null);
      if (scanToken !== activeScanToken) return;

      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era: shouldApplyEra ? era : null,
        rows,
        totalOwnedCount,
        detection: {
          confidence: eraConfidence,
          textPreview: String(eraDetection?.textPreview || ""),
          elapsedMs: toFiniteOr(eraDetection?.elapsedMs, 0),
        },
      });

      windows.scheduleOverlayAutoHide(
        rows.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
      );

      log.log(
        `[RelicSelection] refinement rows sent count=${rows.length} era=${
          shouldApplyEra ? era : "none"
        } conf=${eraConfidence.toFixed(3)} elapsed=${Date.now() - refineStartedAt}ms token=${scanToken}`,
      );
    } catch (err) {
      if (scanToken !== activeScanToken) return;
      log.error("[RelicSelection] recommendation refinement failed:", normalizeErrorMessage(err));
      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era: null,
        rows: [],
      });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    } finally {
      if (scanToken === activeScanToken) {
        inFlight = false;
      }
    }
  }

  async function onRelicSelectionTrigger(source = "manual") {
    if (source === "eelog") {
      const now = Date.now();
      if (toFiniteOr(ctx.overlayDismissedUntilMs, 0) > now) {
        return;
      }
      if (now - lastEelogTriggerAt < MIN_EELOG_TRIGGER_GAP_MS) {
        return;
      }
      lastEelogTriggerAt = now;
    }

    const scanToken = activeScanToken + 1;
    activeScanToken = scanToken;

    if (inFlight) {
      log.log(`[RelicSelection] replacing in-flight planner scan (${source})`);
    }

    inFlight = true;

    try {
      if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) {
        inFlight = false;
        return;
      }

      let preferredDisplayId: string | null = lastKnownGameDisplayId;

      if (preferredDisplayId) {
        windows.setAnchorMeta({ sourceDisplayId: preferredDisplayId });
      }

      windows.clearOverlayAutoHideTimer();
      windows.createOverlayWindow();
      windows.positionOverlayWindow(windows.getAnchorMeta());
      log.log(
        `[RelicSelection] overlay show request source=${source} anchorDisplay=${String(
          windows.getAnchorMeta()?.sourceDisplayId || "unknown",
        )} token=${scanToken}`,
      );
      windows.sendOverlayEvent("relic-planner-trigger", { source });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);

      sendFallbackRows(scanToken, source);

      setTimeout(() => {
        void runRefinement(scanToken, source, preferredDisplayId);
      }, 0);
    } catch (err) {
      if (scanToken !== activeScanToken) return;
      inFlight = false;
      log.error("[RelicSelection] recommendation pipeline failed:", normalizeErrorMessage(err));
      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era: null,
        rows: [],
      });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    }
  }

  function suppressReopenForClose(): void {
    ctx.overlayDismissedUntilMs = Date.now() + REOPEN_SUPPRESS_AFTER_CLOSE_MS;
  }

  return {
    onRelicSelectionTrigger,
    suppressReopenForClose,
  };
}

module.exports = {
  createRelicSelectionController,
};
