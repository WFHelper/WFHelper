import {
  normalizeDucats,
  toFiniteOr,
  clampNumber,
} from "../../config/shared/numeric";
import { normalizeErrorMessage } from "../../config/shared/errors";
import { RELIC_RECOMMENDATIONS, RELIC_PLANNER_TRIGGER } from "../../config/shared/ipcChannels";
import { getWindowsOcrHealth } from "../../services/ocrServer";
import { normalizeWfmSlugKey } from "../../config/shared/wfm";
import { RELIC_MISSION_TIER_CACHE_TTL_MS } from "../../config/runtime/cacheConfig";

const RECOMMENDATION_SQUAD_SIZE = 4;
/** How long computed recommendations stay cached before a full recompute. */
const RECOMMENDATION_CACHE_TTL_MS = 10_000;
/** Minimum gap between two EE.log trigger events to avoid double-firing. */
const MIN_EELOG_TRIGGER_GAP_MS = 900;
/** Max time for the OCR era-detection pass before falling back to desktop filter hint. */
const ERA_DETECTION_TIMEOUT_MS = 1500;
/** Suppress overlay reopen for this long after an explicit close to prevent flicker. */
const REOPEN_SUPPRESS_AFTER_CLOSE_MS = 3_000;

/** Safety net if the InitMapping close never arrives; must outlast a long relic browse. */
const OVERLAY_AUTO_HIDE_SUCCESS_MS = 120_000;
/** Auto-hide after a detection failure - keep visible briefly so the user sees the state. */
const OVERLAY_AUTO_HIDE_FAILURE_MS = 4_500;
/** Hard ceiling for the detecting phase before giving up and hiding. */
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

const QUALITY_ORDER: readonly (keyof OwnedCountRow)[] = Object.freeze([
  "radiant",
  "flawless",
  "exceptional",
  "intact",
]);
const QUALITY_LABEL: Readonly<Record<keyof OwnedCountRow, string>> = Object.freeze({
  intact: "Intact",
  exceptional: "Exceptional",
  flawless: "Flawless",
  radiant: "Radiant",
});


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
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  ctx: {
    overlaySettings: import("../../config/runtime/overlaySettings").OverlaySettings;
    currentInventoryData: Record<string, unknown> | null;
    overlayDismissedUntilMs?: number;
    activeFissureTier?: string | null;
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
      labelOnly?: boolean;
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
  if (low.includes("omnia")) return "omnia";
  return null;
}

// EE.log activeMissionTag values -> relic era; VoidT6 (omnia) accepts any era.
const VOID_TAG_ERAS: Readonly<Record<string, string>> = Object.freeze({
  VOIDT1: "lith",
  VOIDT2: "meso",
  VOIDT3: "neo",
  VOIDT4: "axi",
  VOIDT5: "requiem",
  VOIDT6: "omnia",
});

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

function loadPersistedCacheMaps(
  fs: typeof import("node:fs"),
  cacheFilePath: string,
): { prices: Map<string, number>; ducats: Map<string, number> } {
  const prices = new Map<string, number>();
  const ducats = new Map<string, number>();

  try {
    if (!fs.existsSync(cacheFilePath)) return { prices, ducats };
    const raw = fs.readFileSync(cacheFilePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { prices, ducats };

    // Snapshot format has a nested { prices: {...}, meta: {...} } structure.
    // Legacy flat format had slug entries at the root level.
    const priceRoot = (parsed as Record<string, unknown>).prices;
    const priceEntries: Record<string, unknown> =
      priceRoot !== null && typeof priceRoot === "object" && !Array.isArray(priceRoot)
        ? (priceRoot as Record<string, unknown>)
        : (parsed as Record<string, unknown>);

    for (const [slug, entry] of Object.entries(priceEntries)) {
      if (!entry || typeof entry !== "object") continue;
      const status = String((entry as { status?: unknown }).status || "ok").toLowerCase();
      if (status !== "ok") continue;
      const normalized = normalizeWfmSlugKey(slug);
      if (!normalized) continue;
      const median = toFiniteOr((entry as { median?: unknown }).median, NaN);
      if (!Number.isFinite(median) || median <= 0) continue;
      prices.set(normalized, median);
    }

    // Snapshot also carries order summaries. Use them as a snapshot-only fallback
    // when the median map does not have an entry for a reward slug.
    const orderSummaries = (parsed as Record<string, unknown>).orderSummaries;
    if (
      orderSummaries !== null &&
      typeof orderSummaries === "object" &&
      !Array.isArray(orderSummaries)
    ) {
      for (const [slug, entry] of Object.entries(orderSummaries as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const status = String((entry as { status?: unknown }).status || "ok").toLowerCase();
        if (status !== "ok") continue;
        const normalized = normalizeWfmSlugKey(slug);
        if (!normalized || prices.has(normalized)) continue;

        const record = entry as { wts?: unknown; wtb?: unknown };
        const sellPrice = toFiniteOr(record.wts, NaN);
        const buyPrice = toFiniteOr(record.wtb, NaN);
        const snapshotPrice =
          Number.isFinite(sellPrice) && sellPrice > 0
            ? sellPrice
            : Number.isFinite(buyPrice) && buyPrice > 0
              ? buyPrice
              : NaN;

        if (!Number.isFinite(snapshotPrice) || snapshotPrice <= 0) continue;
        prices.set(normalized, snapshotPrice);
      }
    }

    // Extract ducat values from snapshot meta (only available in snapshot format).
    const meta = (parsed as Record<string, unknown>).meta;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      for (const [slug, entry] of Object.entries(meta as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const ducatValue = normalizeDucats((entry as { ducats?: unknown }).ducats);
        if (ducatValue == null || ducatValue <= 0) continue;
        ducats.set(normalizeWfmSlugKey(slug), ducatValue);
      }
    }
  } catch {
    // Corrupt/unreadable price-cache file - return whatever parsed so far.
    return { prices, ducats };
  }

  return { prices, ducats };
}

function getCacheFileMtimeMs(fs: typeof import("node:fs"), cacheFilePath: string): number {
  try {
    if (!fs.existsSync(cacheFilePath)) return 0;
    const stat = fs.statSync(cacheFilePath);
    const mtimeMs = toFiniteOr((stat as { mtimeMs?: number }).mtimeMs, 0);
    return Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : 0;
  } catch {
    // Missing/unstattable cache file - treat as mtime 0 (forces a refresh).
    return 0;
  }
}

function pickBestOwnedQuality(
  group: RelicGroup,
  ownedRow: OwnedCountRow,
  priceLookup: (slug: string) => number | null,
  squadSize: number,
  getDucats: (slug: string) => number | null,
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
      const slug = normalizeWfmSlugKey(reward?.urlName);
      return slug ? priceLookup(slug) : null;
    });
    const ducatValues = normalizedRewards.map((reward) => {
      // @wfcd/items rarely ships ducat values; fall back to snapshot meta ducats.
      const rewardDucats = normalizeDucats(reward?.ducats);
      if (rewardDucats != null && rewardDucats > 0) return rewardDucats;
      const slug = normalizeWfmSlugKey(reward?.urlName);
      return slug ? getDucats(slug) : null;
    });

    const hasAnyPlat = platValues.some((value) => value != null);
    const hasAnyDucat = ducatValues.some((value) => value != null);
    // Show relics even when neither price nor ducat data is available in the snapshot.
    // Null EVs display as "-p / -d" in the overlay instead of pretending the value is 0.

    const platEv = hasAnyPlat
      ? computeSquadExpected(normalizedRewards, platValues, squadSize)
      : null;
    const ducatEv = hasAnyDucat
      ? computeSquadExpected(normalizedRewards, ducatValues, squadSize)
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
  const { log, ctx, windows, relicService, rewardScanner, wfmStatsPrice, fs, cacheFilePath } =
    options;

  let inFlight = false;
  let activeScanToken = 0;
  let lastEelogTriggerAt = 0;
  let lastKnownGameDisplayId: string | null = null;
  let desktopSquadSize: number = RECOMMENDATION_SQUAD_SIZE;
  let desktopTierHint: string | null = null;
  // Era cache for the current mission session: set on first confident detection,
  // reused for later picks (endless rotations) so OCR is skipped. TTL refreshes
  // on hit; expires only after leaving the mission for longer than the TTL.
  let activeMissionTier: string | null = null;
  let activeMissionTierSetAt = 0;
  // Fissure tier from the EE.log mission tag - authoritative over OCR (omnia
  // screens OCR as "lith" from the visible tiles) and TTL-free (long endless
  // runs outlive the OCR cache). Cleared when a non-fissure mission loads.
  let logMissionTier: string | null = null;
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
    ducats: Map<string, number>;
  } | null = null;

  function getPersistedCacheMaps(): { prices: Map<string, number>; ducats: Map<string, number> } {
    const mtimeMs = getCacheFileMtimeMs(fs, cacheFilePath);
    if (persistedPriceMedianCache && persistedPriceMedianCache.mtimeMs === mtimeMs) {
      return { prices: persistedPriceMedianCache.prices, ducats: persistedPriceMedianCache.ducats };
    }

    const { prices, ducats } = loadPersistedCacheMaps(fs, cacheFilePath);
    persistedPriceMedianCache = { mtimeMs, prices, ducats };
    return { prices, ducats };
  }

  function buildRecommendations(era: string | null): {
    rows: RecommendationRow[];
    totalOwnedCount: number;
  } {
    const db = relicService.getRelicDatabase();
    const groups = Object.values(db.groups || {}) as RelicGroup[];
    const owned = parseOwnedRelicCounts(ctx.currentInventoryData, db.byUniqueName || {});

    const cacheKey = `${era || "all"}|${toStableOwnedFingerprint(owned)}`;
    if (cache && cache.key === cacheKey && Date.now() - cache.ts < RECOMMENDATION_CACHE_TTL_MS) {
      return { rows: cache.rows, totalOwnedCount: cache.totalOwnedCount };
    }

    const { prices: persistedPrices, ducats: persistedDucats } = getPersistedCacheMaps();

    const getPrice = (slug: string): number | null => {
      const normalized = normalizeWfmSlugKey(slug);
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

    const getDucats = (slug: string): number | null => {
      const normalized = normalizeWfmSlugKey(slug);
      if (!normalized) return null;
      return persistedDucats.get(normalized) ?? null;
    };

    let totalOwnedCount = 0;
    const rows: RecommendationRow[] = [];
    // omnia fissures accept every era - no filter
    const eraFilter = era === "omnia" ? null : era;
    for (const group of groups) {
      const groupEra = normalizeEra(group.tier);
      if (eraFilter && groupEra !== eraFilter) continue;

      const ownedRow = owned[group.key];
      if (!ownedRow) continue;

      const groupTotal =
        (ownedRow.intact || 0) +
        (ownedRow.exceptional || 0) +
        (ownedRow.flawless || 0) +
        (ownedRow.radiant || 0);
      totalOwnedCount += groupTotal;

      const best = pickBestOwnedQuality(group, ownedRow, getPrice, desktopSquadSize, getDucats);
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

    cache = {
      key: cacheKey,
      rows,
      era,
      totalOwnedCount,
      ts: Date.now(),
    };

    return { rows, totalOwnedCount };
  }

  function sendFallbackRows(scanToken: number, source: string, era: string | null): void {
    const startedAt = Date.now();
    try {
      const { rows, totalOwnedCount } = buildRecommendations(era);
      if (scanToken !== activeScanToken) return;

      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era,
        rows,
        totalOwnedCount,
        ocrUnavailable: !getWindowsOcrHealth().available,
        detection: {
          confidence: 0,
          textPreview: "",
          elapsedMs: 0,
        },
      });

      if (rows.length > 0) {
        windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_SUCCESS_MS);
      }

      log.info(
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
      const eraDetectStartedAt = Date.now();

      // Era cached: just captureSourceMeta (display anchor refresh). Era needed:
      // skip captureSourceMeta - detectRelicSelectionEra captures the screen itself,
      // a second capture would waste ~600 ms.
      const cacheAge = Date.now() - activeMissionTierSetAt;
      let era: string | null =
        logMissionTier ||
        (activeMissionTier && cacheAge < RELIC_MISSION_TIER_CACHE_TTL_MS ? activeMissionTier : null);
      let eraConfidence = era ? 1.0 : 0;

      if (era) {
        activeMissionTierSetAt = Date.now(); // refresh TTL
        log.info(
          `[RelicSelection] mission tier ${logMissionTier ? "from EE.log tag" : "cache hit"}: ${era} (age ${Math.round(cacheAge / 1000)}s)`,
        );
        if (logMissionTier && typeof rewardScanner.detectRelicSelectionEra === "function") {
          // The tag outlives its mission (no orbiter line clears it), so a lith
          // tag can linger into an omnia equip screen. The filter-tab label is
          // the truth for the pick on screen: a confident read overrides the
          // tag, a miss (mid-mission screens have no tabs) keeps it.
          const labelDetection = await rewardScanner.detectRelicSelectionEra({
            timeoutMs: ERA_DETECTION_TIMEOUT_MS,
            preferredDisplayId,
            labelOnly: true,
          });
          if (scanToken !== activeScanToken) return;

          if (labelDetection?.sourceDisplayId) {
            windows.setAnchorMeta({ sourceDisplayId: labelDetection.sourceDisplayId });
            preferredDisplayId = String(labelDetection.sourceDisplayId);
            lastKnownGameDisplayId = preferredDisplayId;
            windows.positionOverlayWindow(windows.getAnchorMeta());
          }

          const labelEra = normalizeEra(labelDetection?.era || null);
          const labelConfidence = toFiniteOr(labelDetection?.confidence, 0);
          if (
            labelEra &&
            labelConfidence >= 0.9 &&
            labelDetection?.candidateId === "filter-label" &&
            labelEra !== era
          ) {
            log.info(
              `[RelicSelection] filter label overrides mission tag: tag=${era} label=${labelEra}`,
            );
            era = labelEra;
            eraConfidence = labelConfidence;
            activeMissionTier = era;
            activeMissionTierSetAt = Date.now();
          }
        } else if (typeof rewardScanner.captureSourceMeta === "function") {
          const captureMetaStartedAt = Date.now();
          try {
            const sourceMeta = await rewardScanner.captureSourceMeta({ preferredDisplayId });
            if (scanToken !== activeScanToken) return;
            log.info(
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
      } else if (desktopTierHint) {
        era = desktopTierHint;
        eraConfidence = 0.75;
        log.info(`[RelicSelection] using desktop tier hint without OCR: ${desktopTierHint}`);
      } else {
        const eraDetection =
          typeof rewardScanner.detectRelicSelectionEra === "function"
            ? await rewardScanner.detectRelicSelectionEra({
                timeoutMs: ERA_DETECTION_TIMEOUT_MS,
                preferredDisplayId,
              })
            : null;

        if (scanToken !== activeScanToken) return;

        if (eraDetection?.sourceDisplayId) {
          windows.setAnchorMeta({ sourceDisplayId: eraDetection.sourceDisplayId });
          lastKnownGameDisplayId = String(eraDetection.sourceDisplayId);
          windows.positionOverlayWindow(windows.getAnchorMeta());
        }

        era = normalizeEra(eraDetection?.era || null);
        eraConfidence = toFiniteOr(eraDetection?.confidence, 0);

        log.info(
          `[RelicSelection] era detection: era=${era || "none"} conf=${eraConfidence.toFixed(3)} ` +
            `source=${String(eraDetection?.sourceType || "unknown")}:${String(eraDetection?.sourceName || eraDetection?.sourceId || "unknown")} ` +
            `display=${String(eraDetection?.sourceDisplayId || "unknown")} ` +
            `candidate=${String(eraDetection?.candidateId || "-")} preview="${String(eraDetection?.textPreview || "")}"`,
        );

        // Cache a confident detection for the rest of this mission session.
        if (era && eraConfidence >= 0.9) {
          activeMissionTier = era;
          activeMissionTierSetAt = Date.now();
          log.info(`[RelicSelection] activeMissionTier set: ${era}`);
        }
      }

      log.info(`[RelicSelection] era detection elapsed=${Date.now() - eraDetectStartedAt}ms`);

      const shouldApplyEra = Boolean(era && eraConfidence >= 0.9);
      const effectiveEra = shouldApplyEra ? era : desktopTierHint;

      const { rows, totalOwnedCount } = buildRecommendations(effectiveEra);
      if (scanToken !== activeScanToken) return;

      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: effectiveEra,
        rows,
        totalOwnedCount,
        ocrUnavailable: !getWindowsOcrHealth().available,
        detection: {
          confidence: eraConfidence,
          textPreview: "",
          elapsedMs: toFiniteOr(Date.now() - eraDetectStartedAt, 0),
        },
      });

      windows.scheduleOverlayAutoHide(
        rows.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
      );

      log.info(
        `[RelicSelection] refinement rows sent count=${rows.length} era=${
          effectiveEra || "none"
        } conf=${eraConfidence.toFixed(3)} elapsed=${Date.now() - refineStartedAt}ms token=${scanToken}`,
      );

    } catch (err) {
      if (scanToken !== activeScanToken) return;
      log.error("[RelicSelection] recommendation refinement failed:", normalizeErrorMessage(err));
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: null,
        rows: [],
        ocrUnavailable: !getWindowsOcrHealth().available,
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
      log.info(`[RelicSelection] replacing in-flight planner scan (${source})`);
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
      log.info(
        `[RelicSelection] overlay show request source=${source} anchorDisplay=${String(
          windows.getAnchorMeta()?.sourceDisplayId || "unknown",
        )} token=${scanToken}`,
      );
      windows.sendOverlayEvent(RELIC_PLANNER_TRIGGER, { source });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);

      // Only send immediate rows if we have a cached era from this mission session.
      // Without one, buildRecommendations(null) returns all eras which causes a visible
      // flash of every relic before OCR completes.
      const cachedEra =
        logMissionTier ||
        (activeMissionTier && Date.now() - activeMissionTierSetAt < RELIC_MISSION_TIER_CACHE_TTL_MS
          ? activeMissionTier
          : null);
      if (cachedEra) {
        sendFallbackRows(scanToken, source, cachedEra);
      }

      setTimeout(() => {
        void runRefinement(scanToken, source, preferredDisplayId);
      }, 0);
    } catch (err) {
      if (scanToken !== activeScanToken) return;
      inFlight = false;
      log.error("[RelicSelection] recommendation pipeline failed:", normalizeErrorMessage(err));
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: null,
        rows: [],
        ocrUnavailable: !getWindowsOcrHealth().available,
      });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    }
  }

  function suppressReopenForClose(): void {
    ctx.overlayDismissedUntilMs = Date.now() + REOPEN_SUPPRESS_AFTER_CLOSE_MS;
  }

  function setDesktopFilters(filters: { squadSize?: number; tierFilter?: string | null }): void {
    if (typeof filters.squadSize === "number" && filters.squadSize >= 1 && filters.squadSize <= 4) {
      desktopSquadSize = filters.squadSize;
    }
    if (filters.tierFilter !== undefined) {
      desktopTierHint = normalizeEra(filters.tierFilter);
    }
    cache = null;
    log.info(
      `[RelicSelection] desktop filters updated: squadSize=${desktopSquadSize} tierHint=${desktopTierHint || "all"}`,
    );
  }

  function resetMissionTier(): void {
    if (activeMissionTier) {
      log.info(`[RelicSelection] activeMissionTier cleared (menu closed)`);
    }
    // logMissionTier survives picker closes on purpose: the tag only fires on
    // mission load, and the era holds for the whole mission.
    activeMissionTier = null;
    activeMissionTierSetAt = 0;
  }

  function setActiveMissionTag(tag: string): void {
    const era = VOID_TAG_ERAS[String(tag || "").trim().toUpperCase()] ?? null;
    if (era) {
      if (logMissionTier !== era) {
        log.info(`[RelicSelection] mission tier from EE.log tag ${tag}: ${era}`);
      }
      logMissionTier = era;
    } else if (logMissionTier) {
      log.info(`[RelicSelection] mission tier cleared (non-fissure tag ${tag})`);
      logMissionTier = null;
    }
    // shared so the reward overlay can shorten its omnia auto-hide
    ctx.activeFissureTier = logMissionTier;
  }

  return {
    onRelicSelectionTrigger,
    suppressReopenForClose,
    setDesktopFilters,
    resetMissionTier,
    setActiveMissionTag,
  };
}
