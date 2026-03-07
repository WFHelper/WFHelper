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
const NETWORK_FETCH_SLUG_LIMIT = 36;
const NETWORK_FETCH_CONCURRENCY = 6;
const NETWORK_FETCH_TIMEOUT_MS = 1800;
const RECOMMENDATION_CACHE_TTL_MS = 10_000;

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
    captureSourceMeta?: () => Promise<{
      sourceType?: string | null;
      sourceDisplayId?: string | null;
      sourceName?: string | null;
      sourceId?: string | null;
    } | null>;
    detectRelicSelectionEra?: (options?: { timeoutMs?: number }) => Promise<{
      era?: string | null;
      confidence?: number;
      textPreview?: string;
      elapsedMs?: number;
      sourceType?: string | null;
      sourceDisplayId?: string | null;
      candidateId?: string | null;
    }>;
  };
  wfmStatsPrice: {
    fetchPriceBySlug: (slug: string, options?: { timeoutMs?: number }) => Promise<number | null>;
    getCachedPriceBySlug?: (slug: string) => number | null;
  };
  warframeStatus?: {
    getStatus: (options?: { force?: boolean }) => Promise<{
      isOpen: boolean;
      isFocused: boolean;
      focusedProcessName?: string | null;
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

function scoreRewardForNetworkFetch(reward: Reward): number {
  const rarity = String(reward?.rarity || "").toLowerCase();
  const rarityWeight = rarity === "rare" ? 100 : rarity === "uncommon" ? 55 : 20;
  const chance = clampNumber(toFiniteOr(reward?.chance, 0), 0, 100);
  return rarityWeight + (100 - chance) * 0.2;
}

function buildNetworkFetchSlugList(
  groups: RelicGroup[],
  owned: Record<string, OwnedCountRow>,
  era: string | null,
): string[] {
  const ranked = new Map<string, number>();

  for (const group of groups) {
    const groupEra = normalizeEra(group.tier);
    if (era && groupEra !== era) continue;

    const ownedRow = owned[group.key];
    if (!ownedRow) continue;

    for (const quality of QUALITY_ORDER) {
      if ((ownedRow[quality] || 0) <= 0) continue;
      const rewards = group.qualities?.[quality]?.rewards || [];
      for (const reward of rewards) {
        const slug = normalizeSlug(reward?.urlName);
        if (!slug) continue;
        const score = scoreRewardForNetworkFetch(reward);
        const prev = ranked.get(slug) || 0;
        if (score > prev) ranked.set(slug, score);
      }
    }
  }

  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, NETWORK_FETCH_SLUG_LIMIT)
    .map(([slug]) => slug);
}

async function prefetchNetworkPrices(
  slugs: string[],
  fetchPriceBySlug: (slug: string, options?: { timeoutMs?: number }) => Promise<number | null>,
): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();
  const queue = [...slugs];

  const worker = async () => {
    while (queue.length > 0) {
      const slug = queue.shift();
      if (!slug) continue;
      try {
        const price = await fetchPriceBySlug(slug, { timeoutMs: NETWORK_FETCH_TIMEOUT_MS });
        results.set(
          slug,
          typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null,
        );
      } catch {
        results.set(slug, null);
      }
    }
  };

  await Promise.all(Array.from({ length: NETWORK_FETCH_CONCURRENCY }, () => worker()));

  return results;
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
    warframeStatus,
    fs,
    cacheFilePath,
  } = options;

  let inFlight = false;
  let cache: {
    key: string;
    rows: RecommendationRow[];
    era: string | null;
    ts: number;
  } | null = null;

  async function buildRecommendations(era: string | null): Promise<RecommendationRow[]> {
    const db = relicService.getRelicDatabase();
    const groups = Object.values(db.groups || {}) as RelicGroup[];
    const owned = parseOwnedRelicCounts(ctx.currentInventoryData, db.byUniqueName || {});

    const cacheKey = `${era || "all"}|${toStableOwnedFingerprint(owned)}`;
    if (cache && cache.key === cacheKey && Date.now() - cache.ts < RECOMMENDATION_CACHE_TTL_MS) {
      return cache.rows;
    }

    const persistedPrices = loadPersistedPriceMedianMap(fs, cacheFilePath);
    const networkCandidates = buildNetworkFetchSlugList(groups, owned, era);
    const networkPrices = await prefetchNetworkPrices(
      networkCandidates,
      wfmStatsPrice.fetchPriceBySlug,
    );

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

      if (networkPrices.has(normalized)) {
        return networkPrices.get(normalized) || null;
      }

      return null;
    };

    const rows: RecommendationRow[] = [];
    for (const group of groups) {
      const groupEra = normalizeEra(group.tier);
      if (era && groupEra !== era) continue;

      const ownedRow = owned[group.key];
      if (!ownedRow) continue;

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
      ts: Date.now(),
    };

    return sliced;
  }

  async function onRelicSelectionTrigger(source = "manual") {
    if (inFlight) {
      log.log(`[RelicSelection] recommendation scan already running, skip duplicate (${source})`);
      return;
    }

    inFlight = true;

    try {
      if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) return;

      if (source === "eelog" && warframeStatus?.getStatus) {
        const status = await warframeStatus.getStatus();
        if (!status.isOpen) {
          log.log("[RelicSelection] skipped trigger: Warframe not open");
          return;
        }
        if (!status.isFocused) {
          log.log(
            `[RelicSelection] skipped trigger: Warframe not focused (${status.focusedProcessName || "unknown"})`,
          );
          return;
        }
      }

      if (typeof rewardScanner.captureSourceMeta === "function") {
        try {
          const sourceMeta = await rewardScanner.captureSourceMeta();
          if (sourceMeta?.sourceDisplayId) {
            windows.setAnchorMeta({ sourceDisplayId: sourceMeta.sourceDisplayId });
          }
        } catch {
          // non-critical, detection flow will still run
        }
      }

      windows.clearOverlayAutoHideTimer();
      windows.createOverlayWindow();
      windows.positionOverlayWindow(windows.getAnchorMeta());
      windows.sendOverlayEvent("relic-planner-trigger", { source });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);

      const eraDetection =
        typeof rewardScanner.detectRelicSelectionEra === "function"
          ? await rewardScanner.detectRelicSelectionEra({ timeoutMs: 4500 })
          : null;

      if (eraDetection?.sourceDisplayId) {
        windows.setAnchorMeta({ sourceDisplayId: eraDetection.sourceDisplayId });
        windows.positionOverlayWindow(windows.getAnchorMeta());
      }

      const era = normalizeEra(eraDetection?.era || null);

      log.log(
        `[RelicSelection] era detection: era=${era || "none"} conf=${toFiniteOr(eraDetection?.confidence, 0).toFixed(3)} ` +
          `source=${String(eraDetection?.sourceType || "unknown")}/${String(eraDetection?.sourceDisplayId || "unknown")} ` +
          `candidate=${String(eraDetection?.candidateId || "-")} preview="${String(eraDetection?.textPreview || "")}"`,
      );

      const rows = era ? await buildRecommendations(era) : [];
      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era,
        rows,
        detection: {
          confidence: toFiniteOr(eraDetection?.confidence, 0),
          textPreview: String(eraDetection?.textPreview || ""),
          elapsedMs: toFiniteOr(eraDetection?.elapsedMs, 0),
        },
      });

      windows.scheduleOverlayAutoHide(
        rows.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
      );
    } catch (err) {
      log.error("[RelicSelection] recommendation pipeline failed:", normalizeErrorMessage(err));
      windows.sendOverlayEvent("relic-recommendations", {
        source,
        era: null,
        rows: [],
      });
      windows.scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
    } finally {
      inFlight = false;
    }
  }

  return {
    onRelicSelectionTrigger,
  };
}

module.exports = {
  createRelicSelectionController,
};
