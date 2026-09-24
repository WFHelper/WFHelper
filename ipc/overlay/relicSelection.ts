import { normalizeDucats, toFiniteOr, clampNumber } from "../../config/shared/numeric";
import { normalizeErrorMessage } from "../../config/shared/errors";
import { RELIC_RECOMMENDATIONS, RELIC_PLANNER_TRIGGER } from "../../config/shared/ipcChannels";
import { collectRelicInventoryCounts } from "../../config/shared/relicCounts";
import {
  DEFAULT_RELIC_PLANNER_FILTERS,
  normalizeRelicOverlayFilterPush,
  relicDucatonator,
  relicOwnedCountForMode,
  relicQualityForMode,
  selectRelicPlannerRows,
  type RelicPlannerFilters,
  type RelicQuality,
} from "../../config/shared/relicPlannerView";
import { relicGroupMatchesSearch } from "../../config/shared/relicSearch";
import { sortRelicRewards } from "../../config/shared/relicRewardOrder";
import { mainMessage } from "../overlayI18n";
import { getWindowsOcrHealth } from "../../services/ocrServer";
import { rewardOcrOnnxAvailable } from "../../services/rewardOcrOnnx";
import { normalizeOcrPhrase } from "../../config/shared/ocrPhrase";
import { normalizeWfmSlugKey } from "../../config/shared/wfm";
import { RELIC_MISSION_TIER_CACHE_TTL_MS } from "../../config/runtime/cacheConfig";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import { ownedComponentCount } from "../../config/shared/componentNames";
import { withoutFoundryPending } from "../../config/shared/foundryPending";
import * as itemDatabase from "../../services/itemDatabase";

const RECOMMENDATION_SQUAD_SIZE = 4;
const RECOMMENDATION_CACHE_TTL_MS = 10_000;
const MIN_EELOG_TRIGGER_GAP_MS = 900;
const ERA_DETECTION_TIMEOUT_MS = 2400;
const ERA_DETECTION_LABEL_TIMEOUT_MS = 1500;
const ERA_DETECTION_TOTAL_TIMEOUT_MS = 3000;
const ERA_DETECTION_RETRY_DELAY_MS = 700;
const ERA_DETECTION_MIN_RETRY_MS = 600;
const ERA_DETECTION_START_DELAY_MS = 100;
const REOPEN_SUPPRESS_AFTER_CLOSE_MS = 3_000;

const OVERLAY_AUTO_HIDE_SUCCESS_MS = 120_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 4_500;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

const QUALITY_ORDER: readonly RelicQuality[] = Object.freeze([
  "radiant",
  "flawless",
  "exceptional",
  "intact",
]);
const QUALITY_LABEL: Readonly<Record<RelicQuality, string>> = Object.freeze({
  intact: "Intact",
  exceptional: "Exceptional",
  flawless: "Flawless",
  radiant: "Radiant",
});

/** The planner's search treats a refinement word as a filter, so main has to
 *  split it on the same labels the user saw in the desktop view. */
function searchQualityLabels(): Partial<Record<RelicQuality, string>> {
  return {
    intact: mainMessage("relics.quality.intact", QUALITY_LABEL.intact),
    exceptional: mainMessage("relics.quality.exceptional", QUALITY_LABEL.exceptional),
    flawless: mainMessage("relics.quality.flawless", QUALITY_LABEL.flawless),
    radiant: mainMessage("relics.quality.radiant", QUALITY_LABEL.radiant),
  };
}

type Reward = {
  name?: string;
  uniqueName?: string | null;
  imageUrl?: string | null;
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
  code?: string;
  vaulted?: boolean;
  qualities?: Record<string, QualityData | undefined>;
};

type OwnedCountRow = Record<RelicQuality, number>;

type EraDetection = {
  era?: string | null;
  confidence?: number;
  textPreview?: string;
  elapsedMs?: number;
  sourceType?: string | null;
  sourceName?: string | null;
  sourceDisplayId?: string | null;
  sourceId?: string | null;
  candidateId?: string | null;
};

type RecommendationRow = {
  label: string;
  relicName: string;
  quality: string;
  count: number;
  platEv: number | null;
  ducatEv: number | null;
  vaulted: boolean;
  rewards: Array<{
    uniqueName: string | null;
    name: string;
    imageUrl: string | null;
    urlName: string | null;
    rarity: string | null;
    chance: number;
    ownedCount: number | null;
  }>;
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
    }) => Promise<EraDetection>;
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
  eraStartDelayMs?: number;
};

function eraOcrUnavailable(): boolean {
  return !getWindowsOcrHealth().available && !rewardOcrOnnxAvailable();
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
  if (low.includes("omnia")) return "omnia";
  return null;
}

function overlayRowSignature(label: string): string | null {
  const normalized = normalizeOcrPhrase(label);
  return normalized.split(" ").length >= 3 ? normalized : null;
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

  const countedByItemType = collectRelicInventoryCounts(
    inventoryData,
    (itemType) => byUniqueName[itemType] !== undefined,
  );

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

const SNAPSHOT_PRICE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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
    return 0;
  }
}

type QualityRowBuilder = (
  group: RelicGroup,
  quality: RelicQuality,
  count: number,
) => RecommendationRow | null;

function makeQualityRowBuilder(
  priceLookup: (slug: string) => number | null,
  squadSize: number,
  getDucats: (slug: string) => number | null,
): QualityRowBuilder {
  return (group, quality, count) => {
    const rewards = group.qualities?.[quality]?.rewards || [];
    if (rewards.length === 0) return null;

    const normalizedRewards = rewards.map((reward) => ({
      name: reward.name,
      uniqueName: reward.uniqueName,
      imageUrl: reward.imageUrl,
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
      vaulted: Boolean(group.vaulted),
      rewards: sortRelicRewards(normalizedRewards, "rare-first")
        .slice(0, 6)
        .map((reward) => ({
          uniqueName: reward.uniqueName || null,
          name: reward.name || "",
          imageUrl: reward.imageUrl || null,
          urlName: normalizeWfmSlugKey(reward.urlName) || null,
          rarity: reward.rarity || null,
          chance: reward.chance,
          ownedCount: null,
        })),
    };

    return row;
  };
}

/** The owned grade with the highest expected value: the overlay's own pick
 *  before the planner pushes, and whenever the pushed grade is not owned. */
function pickBestOwnedQuality(
  group: RelicGroup,
  ownedRow: OwnedCountRow,
  buildRow: QualityRowBuilder,
): RecommendationRow | null {
  let best: RecommendationRow | null = null;

  for (const quality of QUALITY_ORDER) {
    const count = ownedRow[quality] || 0;
    if (count <= 0) continue;

    const row = buildRow(group, quality, count);
    if (!row) continue;

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

function compareOverlayDefaultRows(a: RecommendationRow, b: RecommendationRow): number {
  const aPlat = a.platEv ?? -1;
  const bPlat = b.platEv ?? -1;
  if (bPlat !== aPlat) return bPlat - aPlat;

  const aDucat = a.ducatEv ?? -1;
  const bDucat = b.ducatEv ?? -1;
  if (bDucat !== aDucat) return bDucat - aDucat;

  return a.label.localeCompare(b.label);
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
  const eraStartDelayMs = options.eraStartDelayMs ?? ERA_DETECTION_START_DELAY_MS;

  let inFlight = false;
  let activeScanToken = 0;
  let lastEelogTriggerAt = 0;
  let lastKnownGameDisplayId: string | null = null;
  let desktopSquadSize: number = RECOMMENDATION_SQUAD_SIZE;
  let desktopTierHint: string | null = null;
  // Null until the planner pushes: the overlay keeps its own ordering until then.
  let desktopFilters: RelicPlannerFilters | null = null;
  let desktopNeededRewardKeys: ReadonlySet<string> | null = null;
  let desktopPinnedQualities: ReadonlyMap<string, RelicQuality> | null = null;
  let activeMissionTier: string | null = null;
  let activeMissionTierSetAt = 0;
  let logMissionTier: string | null = null;
  let overlayRowSignatures: string[] = [];
  let scanDismissBaselineMs = 0;
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

  function getSnapshotPrice(slugInput: string): number | null {
    const normalized = normalizeWfmSlugKey(slugInput);
    if (!normalized) return null;
    const mtimeMs = getCacheFileMtimeMs(fs, cacheFilePath);
    if (!mtimeMs || Date.now() - mtimeMs > SNAPSHOT_PRICE_MAX_AGE_MS) return null;
    const { prices } = getPersistedCacheMaps();
    return prices.get(normalized) ?? null;
  }

  function applyPushedFilters(
    built: ReadonlyArray<{ group: RelicGroup; ownedRow: OwnedCountRow; row: RecommendationRow }>,
    filters: RelicPlannerFilters,
  ): RecommendationRow[] {
    const qualityLabels = filters.search ? searchQualityLabels() : undefined;
    const plannerRows = built.map((entry) => ({
      ...entry,
      name: entry.row.relicName,
      tier: entry.group.tier || "",
      vaulted: entry.row.vaulted,
      ownedCount: relicOwnedCountForMode(entry.ownedRow, filters.qualityMode),
      ownedTotal: relicOwnedCountForMode(entry.ownedRow, "owned"),
      plat: entry.row.platEv,
      ducat: entry.row.ducatEv,
      ratio: relicDucatonator(entry.row.platEv, entry.row.ducatEv),
    }));

    return selectRelicPlannerRows(plannerRows, filters, {
      matchesSearch: (entry) =>
        relicGroupMatchesSearch(entry.group, filters.search, {
          qualityLabels,
          ownedCounts: entry.ownedRow,
        }),
      hasNeededReward: (entry) => desktopNeededRewardKeys?.has(entry.group.key) === true,
    }).map((entry) => entry.row);
  }

  function buildRecommendations(era: string | null): {
    rows: ReturnType<typeof enrichOwnership>;
    totalOwnedCount: number;
  } {
    const db = relicService.getRelicDatabase();
    const groups = Object.values(db.groups || {}) as RelicGroup[];
    const owned = parseOwnedRelicCounts(ctx.currentInventoryData, db.byUniqueName || {});

    const cacheKey = `${era || "all"}|${toStableOwnedFingerprint(owned)}`;
    if (cache && cache.key === cacheKey && Date.now() - cache.ts < RECOMMENDATION_CACHE_TTL_MS) {
      return { rows: enrichOwnership(cache.rows), totalOwnedCount: cache.totalOwnedCount };
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

    const buildRow = makeQualityRowBuilder(getPrice, desktopSquadSize, getDucats);
    const filters = desktopFilters;
    let totalOwnedCount = 0;
    const built: Array<{ group: RelicGroup; ownedRow: OwnedCountRow; row: RecommendationRow }> = [];
    // An omnia fissure takes every era but Requiem: those open only in a Requiem fissure.
    const eraFilter = era === "omnia" ? null : era;
    for (const group of groups) {
      const groupEra = normalizeEra(group.tier);
      if (eraFilter && groupEra !== eraFilter) continue;
      if (era === "omnia" && groupEra === "requiem") continue;

      const ownedRow = owned[group.key];
      if (!ownedRow) continue;

      totalOwnedCount += relicOwnedCountForMode(ownedRow, "owned");

      const quality = filters
        ? relicQualityForMode(
            filters.qualityMode,
            ownedRow,
            desktopPinnedQualities?.get(group.key) ?? null,
          )
        : null;
      const count = quality ? ownedRow[quality] || 0 : 0;
      const best =
        quality && count > 0
          ? buildRow(group, quality, count)
          : pickBestOwnedQuality(group, ownedRow, buildRow);
      if (best) built.push({ group, ownedRow, row: best });
    }

    const rows = filters
      ? applyPushedFilters(built, filters)
      : built.map((entry) => entry.row).sort(compareOverlayDefaultRows);

    cache = {
      key: cacheKey,
      rows,
      era,
      totalOwnedCount,
      ts: Date.now(),
    };

    return { rows: enrichOwnership(rows), totalOwnedCount };
  }

  function enrichOwnership(rows: readonly RecommendationRow[]) {
    if (!rows.length) return [];
    const inventory = ctx.currentInventoryData;
    const owned = inventory
      ? aggregateComponentOwnership(
          withoutFoundryPending(inventory, itemDatabase.isReusableBlueprint),
        )
      : null;
    return rows.map((row) => ({
      ...row,
      rewards: row.rewards.map((reward) => {
        const resolved = itemDatabase.lookupItemByNameOrSlug(reward.name, reward.urlName);
        const uniqueName = resolved?.uniqueName || reward.uniqueName;
        const item = resolved?.item || (uniqueName ? itemDatabase.lookupItem(uniqueName) : null);
        return {
          rarity: reward.rarity,
          chance: reward.chance,
          name: reward.name || item?.name || reward.urlName || "",
          imageUrl: reward.imageUrl || item?.imageUrl || null,
          ownedCount: owned && uniqueName ? ownedComponentCount(uniqueName, owned) : null,
        };
      }),
    }));
  }

  function rememberOverlayRows(rows: readonly Pick<RecommendationRow, "label">[]): void {
    overlayRowSignatures = rows
      .map((row) => overlayRowSignature(row.label))
      .filter((signature): signature is string => signature !== null);
  }

  function rejectSelfRead(detection: EraDetection | null): EraDetection | null {
    if (!detection || !normalizeEra(detection.era || null)) return detection;
    const preview = normalizeOcrPhrase(detection.textPreview);
    if (!preview || !overlayRowSignatures.some((signature) => preview.includes(signature))) {
      return detection;
    }
    log.info(
      `[RelicSelection] era read matched our own overlay rows, ignoring candidate=${String(
        detection.candidateId || "-",
      )}`,
    );
    return { ...detection, era: null, confidence: 0 };
  }

  function sendFallbackRows(scanToken: number, source: string, era: string | null): void {
    const startedAt = Date.now();
    try {
      const { rows, totalOwnedCount } = buildRecommendations(era);
      if (scanToken !== activeScanToken) return;

      rememberOverlayRows(rows);
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era,
        rows,
        totalOwnedCount,
        ocrUnavailable: eraOcrUnavailable(),
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

      const cacheAge = Date.now() - activeMissionTierSetAt;
      let era: string | null =
        logMissionTier ||
        (activeMissionTier && cacheAge < RELIC_MISSION_TIER_CACHE_TTL_MS
          ? activeMissionTier
          : null);
      let eraConfidence = era ? 1.0 : 0;

      if (era) {
        if (logMissionTier) activeMissionTierSetAt = Date.now();
        log.info(
          logMissionTier
            ? `[RelicSelection] mission tier from EE.log tag: ${era}`
            : `[RelicSelection] mission tier cache hit: ${era} (age ${Math.round(cacheAge / 1000)}s)`,
        );
        if (logMissionTier && typeof rewardScanner.detectRelicSelectionEra === "function") {
          const labelDetection = rejectSelfRead(
            await rewardScanner.detectRelicSelectionEra({
              timeoutMs: ERA_DETECTION_LABEL_TIMEOUT_MS,
              preferredDisplayId,
              labelOnly: true,
            }),
          );
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
            labelEra !== era &&
            // Requiem relics open only in a Requiem fissure, so no other tag can sit on a
            // screen that offers them.
            labelEra !== "requiem"
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
            // ignored
          }
        }
      } else if (desktopTierHint) {
        era = desktopTierHint;
        eraConfidence = 0.75;
        log.info(`[RelicSelection] using desktop tier hint without OCR: ${desktopTierHint}`);
      } else {
        const detectEra =
          typeof rewardScanner.detectRelicSelectionEra === "function"
            ? rewardScanner.detectRelicSelectionEra
            : null;
        let eraDetection = detectEra
          ? rejectSelfRead(
              await detectEra({ timeoutMs: ERA_DETECTION_TIMEOUT_MS, preferredDisplayId }),
            )
          : null;

        if (scanToken !== activeScanToken) return;

        const emptyRead = Boolean(detectEra && eraDetection && !normalizeEra(eraDetection.era));
        const retryBudgetMs =
          ERA_DETECTION_TOTAL_TIMEOUT_MS -
          (Date.now() - eraDetectStartedAt) -
          ERA_DETECTION_RETRY_DELAY_MS;
        if (detectEra && emptyRead && retryBudgetMs >= ERA_DETECTION_MIN_RETRY_MS) {
          log.info(`[RelicSelection] era read empty, retrying once budget=${retryBudgetMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, ERA_DETECTION_RETRY_DELAY_MS));
          if (scanToken !== activeScanToken) return;
          const retryDetection = rejectSelfRead(
            await detectEra({
              timeoutMs: Math.min(ERA_DETECTION_TIMEOUT_MS, retryBudgetMs),
              preferredDisplayId,
            }),
          );
          if (scanToken !== activeScanToken) return;
          if (retryDetection) eraDetection = retryDetection;
        } else if (emptyRead) {
          log.info(`[RelicSelection] era read empty, retry budget spent (${retryBudgetMs}ms)`);
        }

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

        if (era && eraConfidence >= 0.9 && eraDetection?.candidateId === "filter-label") {
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

      if (toFiniteOr(ctx.overlayDismissedUntilMs, 0) > scanDismissBaselineMs) {
        log.info(`[RelicSelection] refinement dropped, overlay closed token=${scanToken}`);
        return;
      }

      rememberOverlayRows(rows);
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: effectiveEra,
        rows,
        totalOwnedCount,
        ocrUnavailable: eraOcrUnavailable(),
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
      rememberOverlayRows([]);
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: null,
        rows: [],
        ocrUnavailable: eraOcrUnavailable(),
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
    scanDismissBaselineMs = toFiniteOr(ctx.overlayDismissedUntilMs, 0);

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
      }, eraStartDelayMs);
    } catch (err) {
      if (scanToken !== activeScanToken) return;
      inFlight = false;
      log.error("[RelicSelection] recommendation pipeline failed:", normalizeErrorMessage(err));
      rememberOverlayRows([]);
      windows.sendOverlayEvent(RELIC_RECOMMENDATIONS, {
        source,
        era: null,
        rows: [],
        ocrUnavailable: eraOcrUnavailable(),
      });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    }
  }

  function suppressReopenForClose(): void {
    ctx.overlayDismissedUntilMs = Date.now() + REOPEN_SUPPRESS_AFTER_CLOSE_MS;
  }

  function setDesktopFilters(rawFilters: unknown): void {
    if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) return;

    const { tierFilter, neededRewardKeys, pinnedQualities, ...filters } =
      normalizeRelicOverlayFilterPush(
        rawFilters,
        desktopFilters ?? { ...DEFAULT_RELIC_PLANNER_FILTERS, squadSize: desktopSquadSize },
      );

    desktopSquadSize = filters.squadSize;
    desktopTierHint = normalizeEra(tierFilter);
    desktopFilters = filters;
    desktopNeededRewardKeys = neededRewardKeys ? new Set(neededRewardKeys) : null;
    desktopPinnedQualities = pinnedQualities ? new Map(Object.entries(pinnedQualities)) : null;
    cache = null;
    log.info(
      `[RelicSelection] desktop filters updated: squadSize=${desktopSquadSize} ` +
        `tierHint=${desktopTierHint || "all"} sort=${filters.sortMode}/${filters.sortDirection} ` +
        `quality=${filters.qualityMode} vaulted=${filters.vaultedMode} ` +
        `copies=${filters.ownedAbove || "any"} ` +
        `search=${filters.search ? "yes" : "no"} needed=${desktopNeededRewardKeys?.size ?? "off"} ` +
        `pinned=${desktopPinnedQualities?.size ?? 0}`,
    );
  }

  function resetMissionTier(): void {
    if (activeMissionTier) {
      log.info(`[RelicSelection] activeMissionTier cleared (menu closed)`);
    }
    // The EE.log tag only fires on mission load, so logMissionTier outlives a picker close.
    activeMissionTier = null;
    activeMissionTierSetAt = 0;
  }

  function setActiveMissionTag(tag: string): void {
    const era =
      VOID_TAG_ERAS[
        String(tag || "")
          .trim()
          .toUpperCase()
      ] ?? null;
    if (era) {
      if (logMissionTier !== era) {
        log.info(`[RelicSelection] mission tier from EE.log tag ${tag}: ${era}`);
      }
      logMissionTier = era;
    } else if (logMissionTier) {
      log.info(`[RelicSelection] mission tier cleared (non-fissure tag ${tag})`);
      logMissionTier = null;
    }
    ctx.activeFissureTier = logMissionTier;
  }

  return {
    onRelicSelectionTrigger,
    suppressReopenForClose,
    setDesktopFilters,
    resetMissionTier,
    setActiveMissionTag,
    getSnapshotPrice,
  };
}
