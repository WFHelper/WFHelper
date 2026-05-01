import { fetchPriceBySlug, onPriceCacheUpdate, type RequestPriority } from "../wfm/wfmPrice.js";
import { getCachedPriceState } from "../wfm/priceCache.js";
import { fetchWfmItemMetaBySlug } from "../wfm/wfmItemMeta.js";
import type {
  RelicDatabase,
  RelicGroup,
  RelicQuality,
  RelicQualityData,
  RelicReward,
} from "../../types/relics.js";
import { QUALITY_MODES } from "./relicConstants.js";
import { computeSquadDucatEV, computeSquadEV } from "./relicMath.js";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const EV_NODATA_TTL_MS = 2 * 60 * 1000;
const EV_TRANSIENT_MS = 30_000;
const EV_BATCH_SIZE = 30;
const EV_WORKERS = 4;
const RELIC_CARD_NODATA_TTL_MS = 5 * 60 * 1000;
const RELIC_CARD_WARMUP_BATCH_SIZE = 48;
const RELIC_CARD_WARMUP_WORKERS = 3;
const PRIME_PRICE_WARMUP_BATCH_SIZE = 80;
const PRIME_PRICE_WARMUP_WORKERS = 4;
const DUCAT_WARMUP_BATCH_SIZE = 90;
const DUCAT_WARMUP_WORKERS = 4;
const WARMUP_LOOP_PAUSE_MS = 50;
const GROUP_PRICE_FETCH_WORKERS = 4;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type RelicQualityMode = "best" | RelicQuality;

interface QualityPriceData {
  rewards: RelicReward[];
  prices: Array<number | null>;
  hasAnyPrice: boolean;
}

interface GroupPriceSnapshot {
  transient: boolean;
  qualities: Partial<Record<RelicQuality, QualityPriceData>>;
}

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

const evCache = new Map<string, number>();
const evNoDataCache = new Map<string, number>();
const evPending = new Set<string>();
const groupPriceCache = new Map<string, GroupPriceSnapshot>();
const groupPricePending = new Set<string>();
const relicCardPriceCache = new Map<string, number>();
const relicCardPricePending = new Set<string>();
const relicCardNoDataCache = new Map<string, number>();
const rewardDucatCache = new Map<string, number | null>();
const rewardDucatPending = new Set<string>();
const primeRewardWarmupComplete = new Set<string>();
const rewardSlugToGroups = new Map<string, Set<string>>();

let activeRuntimeFingerprint: string | null = null;

let warmupRunning = false;
let warmupToken = 0;
let cardWarmupRunning = false;
let cardWarmupToken = 0;
let primeWarmupRunning = false;
let primeWarmupToken = 0;
let ducatWarmupRunning = false;
let ducatWarmupToken = 0;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function fnv1aStep(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function computeRelicDbFingerprint(db: RelicDatabase): string {
  let hash = 0x811c9dc5;
  const groups = Object.values(db.groups || {}).sort((a, b) => a.key.localeCompare(b.key));

  hash = fnv1aStep(hash, `groups:${groups.length}`);

  for (const group of groups) {
    hash = fnv1aStep(hash, `g:${group.key}|${group.tier}|${group.code}`);
    const qualityEntries = Object.entries(group.qualities || {}).sort((a, b) =>
      a[0].localeCompare(b[0]),
    ) as Array<[RelicQuality, RelicQualityData]>;

    for (const [quality, qData] of qualityEntries) {
      hash = fnv1aStep(hash, `q:${quality}|${qData.uniqueName || ""}`);
      const rewardSlugs = (qData.rewards || []).map((reward) => reward?.urlName || "").sort();
      hash = fnv1aStep(hash, `r:${rewardSlugs.join(",")}`);
    }
  }

  return `f${hash.toString(16).padStart(8, "0")}`;
}

export function configureRelicRuntimeCacheFingerprint(db: RelicDatabase | null | undefined): void {
  if (!db) return;

  const nextFingerprint = computeRelicDbFingerprint(db);
  if (activeRuntimeFingerprint === nextFingerprint) return;

  const previousFingerprint = activeRuntimeFingerprint;
  activeRuntimeFingerprint = nextFingerprint;

  if (previousFingerprint != null) {
    evCache.clear();
    evNoDataCache.clear();
    groupPriceCache.clear();
    relicCardPriceCache.clear();
    relicCardNoDataCache.clear();
    primeRewardWarmupComplete.clear();
    rewardSlugToGroups.clear();
  }
}

// ---------------------------------------------------------------------------
// EV cache key helpers
// ---------------------------------------------------------------------------

function evCacheKey(groupKey: string, squadSize: number, qualityMode: string): string {
  return `${groupKey}|${squadSize}|${qualityMode}`;
}

export function getCachedEv(
  groupKey: string,
  squadSize: number,
  qualityMode: string,
): number | null {
  return evCache.get(evCacheKey(groupKey, squadSize, qualityMode)) ?? null;
}

export function evHasFreshNoData(
  groupKey: string,
  squadSize: number,
  qualityMode: string,
): boolean {
  const ts = evNoDataCache.get(evCacheKey(groupKey, squadSize, qualityMode));
  return Boolean(ts && Date.now() - ts < EV_NODATA_TTL_MS);
}

// ---------------------------------------------------------------------------
// Cache reset / cancellation
// ---------------------------------------------------------------------------

export function cancelWarmup(): void {
  warmupToken += 1;
  warmupRunning = false;
  cardWarmupToken += 1;
  cardWarmupRunning = false;
  ducatWarmupToken += 1;
  ducatWarmupRunning = false;
}

// ---------------------------------------------------------------------------
// Price invalidation index
// ---------------------------------------------------------------------------

function clearGroupEvCaches(groupKey: string): void {
  groupPriceCache.delete(groupKey);

  for (let squad = 1; squad <= 4; squad += 1) {
    evCache.delete(evCacheKey(groupKey, squad, "best"));
    evNoDataCache.delete(evCacheKey(groupKey, squad, "best"));

    for (const quality of QUALITY_MODES) {
      evCache.delete(evCacheKey(groupKey, squad, quality));
      evNoDataCache.delete(evCacheKey(groupKey, squad, quality));
    }
  }
}

function indexGroupRewardSlugs(group: RelicGroup): void {
  const qualityDataList = Object.values(group.qualities || {}) as RelicQualityData[];
  for (const qualityData of qualityDataList) {
    for (const reward of qualityData?.rewards || []) {
      const slug = reward?.urlName;
      if (!slug) continue;
      let groups = rewardSlugToGroups.get(slug);
      if (!groups) {
        groups = new Set<string>();
        rewardSlugToGroups.set(slug, groups);
      }
      groups.add(group.key);
    }
  }
}

function indexGroupsForPriceInvalidation(groups: RelicGroup[]): void {
  for (const group of groups) {
    indexGroupRewardSlugs(group);
  }
}

onPriceCacheUpdate((slug, status) => {
  if (status !== "ok") return;
  const affectedGroups = rewardSlugToGroups.get(slug);
  if (!affectedGroups) return;
  for (const groupKey of affectedGroups) {
    clearGroupEvCaches(groupKey);
  }
});

// ---------------------------------------------------------------------------
// Ducat helpers
// ---------------------------------------------------------------------------

function cachedRewardDucats(reward: RelicReward): number | null {
  if (typeof reward.ducats === "number" && Number.isFinite(reward.ducats)) {
    return Math.max(0, Math.round(reward.ducats));
  }

  if (!reward.urlName) return null;
  if (!rewardDucatCache.has(reward.urlName)) return null;
  const cached = rewardDucatCache.get(reward.urlName);
  return typeof cached === "number" && Number.isFinite(cached) ? cached : null;
}

function qualityModesFor(mode: RelicQualityMode): RelicQuality[] {
  if (mode === "best") return QUALITY_MODES;
  return [mode];
}

function qualityDucatEV(
  qualityData: RelicQualityData | undefined,
  squadSize: number,
): number | null {
  if (!qualityData) return null;

  const rewards = qualityData.rewards || [];
  if (rewards.length === 0) return null;

  const ducats = rewards.map((reward) => cachedRewardDucats(reward));
  const hasAny = ducats.some((value) => value != null);
  if (!hasAny) return null;

  return computeSquadDucatEV(rewards, ducats, squadSize);
}

export function computeGroupDucatEv(
  group: RelicGroup,
  squadSize: number,
  qualityMode: RelicQualityMode,
): number | null {
  let best: number | null = null;

  for (const quality of qualityModesFor(qualityMode)) {
    const qualityData = group.qualities?.[quality];
    const ev = qualityDucatEV(qualityData, squadSize);
    if (ev == null) continue;
    if (best == null || ev > best) best = ev;
  }

  return best;
}

export function computeGroupDucatonator(
  group: RelicGroup,
  squadSize: number,
  qualityMode: RelicQualityMode,
): number | null {
  const ducatEv = computeGroupDucatEv(group, squadSize, qualityMode);
  const platEv = getCachedEv(group.key, squadSize, qualityMode);
  if (ducatEv == null || platEv == null || platEv <= 0) return null;
  return ducatEv / platEv;
}

// ---------------------------------------------------------------------------
// Relic card price
// ---------------------------------------------------------------------------

function relicGroupSlug(groupKey: string): string {
  const normalized = groupKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${normalized}_relic`;
}

async function prefetchRelicCardPrice(
  groupKey: string,
  priority: RequestPriority = "normal",
): Promise<boolean> {
  const noDataTs = relicCardNoDataCache.get(groupKey);
  if (noDataTs && Date.now() - noDataTs < RELIC_CARD_NODATA_TTL_MS) {
    return false;
  }

  if (!groupKey || relicCardPriceCache.has(groupKey) || relicCardPricePending.has(groupKey)) {
    return false;
  }

  relicCardPricePending.add(groupKey);
  try {
    const result = await fetchPriceBySlug(relicGroupSlug(groupKey), { priority });
    if (result.status === "ok" && result.median != null) {
      relicCardPriceCache.set(groupKey, result.median);
      relicCardNoDataCache.delete(groupKey);
      return true;
    }
    if (result.status === "no_data") {
      relicCardNoDataCache.set(groupKey, Date.now());
    }
    return false;
  } finally {
    relicCardPricePending.delete(groupKey);
  }
}

// ---------------------------------------------------------------------------
// Warmup: relic card prices
// ---------------------------------------------------------------------------

export async function warmupRelicCardPrices(
  groups: RelicGroup[],
  onBatchDone: () => void,
  priority: RequestPriority = "normal",
): Promise<void> {
  if (cardWarmupRunning) return;
  indexGroupsForPriceInvalidation(groups);
  cardWarmupRunning = true;

  const token = ++cardWarmupToken;

  try {
    for (;;) {
      if (token !== cardWarmupToken) return;

      const now = Date.now();
      const queue: RelicGroup[] = [];

      for (const group of groups) {
        const noDataTs = relicCardNoDataCache.get(group.key);
        if (relicCardPriceCache.has(group.key)) continue;
        if (relicCardPricePending.has(group.key)) continue;
        if (noDataTs && now - noDataTs < RELIC_CARD_NODATA_TTL_MS) continue;

        queue.push(group);
        if (queue.length >= RELIC_CARD_WARMUP_BATCH_SIZE) break;
      }

      if (queue.length === 0) break;

      await Promise.all(
        Array.from({ length: RELIC_CARD_WARMUP_WORKERS }, async () => {
          for (;;) {
            if (token !== cardWarmupToken) return;
            const group = queue.shift();
            if (!group) return;
            await prefetchRelicCardPrice(group.key, priority);
          }
        }),
      );

      if (token === cardWarmupToken) onBatchDone();
      await new Promise((resolve) => setTimeout(resolve, WARMUP_LOOP_PAUSE_MS));
    }
  } finally {
    if (token === cardWarmupToken) {
      cardWarmupRunning = false;
      onBatchDone();
    }
  }
}

// ---------------------------------------------------------------------------
// Warmup: prime reward prices
// ---------------------------------------------------------------------------

function collectPrimeRewardSlugs(groups: RelicGroup[]): string[] {
  const unique = new Set<string>();

  for (const group of groups) {
    const qualities = Object.values(group.qualities || {}) as RelicQualityData[];
    for (const quality of qualities) {
      for (const reward of quality?.rewards || []) {
        if (reward?.urlName) unique.add(reward.urlName);
      }
    }
  }

  return [...unique];
}

function groupHasAnyCachedRewardPrice(group: RelicGroup): boolean {
  const qualityDataList = Object.values(group.qualities || {}) as RelicQualityData[];
  for (const qualityData of qualityDataList) {
    for (const reward of qualityData?.rewards || []) {
      const slug = reward?.urlName;
      if (!slug) continue;
      const cached = getCachedPriceState(slug);
      if (cached?.status === "ok" && cached.median != null) {
        return true;
      }
    }
  }
  return false;
}

export async function warmupPrimeRewardPriceCache(
  db: RelicDatabase | null | undefined,
): Promise<void> {
  if (!db || primeWarmupRunning) return;

  indexGroupsForPriceInvalidation(Object.values(db.groups || {}));

  const allSlugs = collectPrimeRewardSlugs(Object.values(db.groups || {}));
  const queue = allSlugs.filter((slug) => !primeRewardWarmupComplete.has(slug));
  if (queue.length === 0) return;

  primeWarmupRunning = true;
  const token = ++primeWarmupToken;

  try {
    for (;;) {
      if (token !== primeWarmupToken) return;
      const batch = queue.splice(0, PRIME_PRICE_WARMUP_BATCH_SIZE);
      if (batch.length === 0) break;

      await Promise.all(
        Array.from({ length: PRIME_PRICE_WARMUP_WORKERS }, async () => {
          for (;;) {
            if (token !== primeWarmupToken) return;
            const slug = batch.shift();
            if (!slug) return;
            const result = await fetchPriceBySlug(slug, { priority: "low" });
            if (result.status !== "transient") {
              primeRewardWarmupComplete.add(slug);
            }
          }
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, WARMUP_LOOP_PAUSE_MS));
    }
  } finally {
    if (token === primeWarmupToken) {
      primeWarmupRunning = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Ducat prefetch / warmup
// ---------------------------------------------------------------------------

async function prefetchRewardDucats(
  slug: string | null | undefined,
  priority: RequestPriority = "low",
): Promise<boolean> {
  if (!slug) return false;
  if (rewardDucatCache.has(slug) || rewardDucatPending.has(slug)) {
    return false;
  }

  rewardDucatPending.add(slug);
  try {
    const meta = await fetchWfmItemMetaBySlug(slug, { priority });
    const ducats =
      typeof meta?.ducats === "number" && Number.isFinite(meta.ducats)
        ? Math.max(0, Math.round(meta.ducats))
        : null;

    rewardDucatCache.set(slug, ducats);
    return ducats != null;
  } finally {
    rewardDucatPending.delete(slug);
  }
}

function collectRewardSlugsForDucatWarmup(groups: RelicGroup[]): string[] {
  const unique = new Set<string>();

  for (const group of groups) {
    const qualities = Object.values(group.qualities || {}) as RelicQualityData[];
    for (const quality of qualities) {
      for (const reward of quality?.rewards || []) {
        const slug = reward?.urlName;
        if (!slug) continue;
        if (typeof reward.ducats === "number" && Number.isFinite(reward.ducats)) {
          rewardDucatCache.set(slug, Math.max(0, Math.round(reward.ducats)));
          continue;
        }
        if (rewardDucatCache.has(slug) || rewardDucatPending.has(slug)) continue;
        unique.add(slug);
      }
    }
  }

  return [...unique];
}

export async function warmupRewardDucats(
  groups: RelicGroup[],
  onBatchDone: () => void,
  priority: RequestPriority = "low",
): Promise<void> {
  if (ducatWarmupRunning) return;
  ducatWarmupRunning = true;

  const token = ++ducatWarmupToken;

  try {
    for (;;) {
      if (token !== ducatWarmupToken) return;

      const queue = collectRewardSlugsForDucatWarmup(groups).slice(0, DUCAT_WARMUP_BATCH_SIZE);
      if (queue.length === 0) break;

      await Promise.all(
        Array.from({ length: DUCAT_WARMUP_WORKERS }, async () => {
          for (;;) {
            if (token !== ducatWarmupToken) return;
            const slug = queue.shift();
            if (!slug) return;
            await prefetchRewardDucats(slug, priority);
          }
        }),
      );

      if (token === ducatWarmupToken) onBatchDone();
      await new Promise((resolve) => setTimeout(resolve, WARMUP_LOOP_PAUSE_MS));
    }
  } finally {
    if (token === ducatWarmupToken) {
      ducatWarmupRunning = false;
      onBatchDone();
    }
  }
}

// ---------------------------------------------------------------------------
// Group EV computation
// ---------------------------------------------------------------------------

async function buildPriceSnapshot(
  group: RelicGroup,
  priority: RequestPriority,
): Promise<GroupPriceSnapshot> {
  const snapshot: GroupPriceSnapshot = { transient: false, qualities: {} };

  const qualityEntries = Object.entries(group.qualities || {}) as Array<
    [RelicQuality, RelicQualityData]
  >;

  const uniqueSlugs = [
    ...new Set(
      qualityEntries.flatMap(([, qualityData]) =>
        (qualityData.rewards || [])
          .map((reward) => reward?.urlName)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ),
  ];

  const priceMap = new Map<string, Awaited<ReturnType<typeof fetchPriceBySlug>>>();
  const slugQueue = [...uniqueSlugs];
  await Promise.all(
    Array.from({ length: GROUP_PRICE_FETCH_WORKERS }, async () => {
      for (;;) {
        const slug = slugQueue.shift();
        if (!slug) return;
        priceMap.set(slug, await fetchPriceBySlug(slug, { priority }));
      }
    }),
  );

  for (const [qualityName, qualityData] of qualityEntries) {
    const rewards = qualityData.rewards || [];
    const results = rewards.map((reward) =>
      reward?.urlName
        ? (priceMap.get(reward.urlName) ?? {
            status: "no_slug",
            median: null,
          })
        : { status: "no_slug", median: null },
    );

    if (results.some((result) => result.status === "transient")) {
      snapshot.transient = true;
    }

    const prices = results.map((result) => (result.status === "ok" ? result.median : null));
    snapshot.qualities[qualityName] = {
      rewards,
      prices,
      hasAnyPrice: prices.some((price) => price != null),
    };
  }

  return snapshot;
}

async function computeGroupEv(
  group: RelicGroup,
  priority: RequestPriority = "normal",
): Promise<void> {
  const sentinelKey = evCacheKey(group.key, 1, "best");
  if (evCache.has(sentinelKey)) return;
  const noDataTs = evNoDataCache.get(sentinelKey);
  if (
    noDataTs &&
    Date.now() - noDataTs < EV_NODATA_TTL_MS &&
    !groupHasAnyCachedRewardPrice(group)
  ) {
    return;
  }
  if (evPending.has(sentinelKey) || groupPricePending.has(group.key)) return;

  evPending.add(sentinelKey);
  groupPricePending.add(group.key);

  try {
    let snapshot = groupPriceCache.get(group.key);
    if (!snapshot) {
      snapshot = await buildPriceSnapshot(group, priority);
      if (!snapshot.transient) {
        groupPriceCache.set(group.key, snapshot);
      }
    }

    for (let squad = 1; squad <= 4; squad += 1) {
      let bestEv: number | null = null;

      for (const qualityMode of QUALITY_MODES) {
        const qualityData = snapshot.qualities[qualityMode];
        const qualityKey = evCacheKey(group.key, squad, qualityMode);

        if (!qualityData?.hasAnyPrice) {
          if (!snapshot.transient) {
            evNoDataCache.set(qualityKey, Date.now());
          }
          continue;
        }

        const qualityEv = computeSquadEV(qualityData.rewards, qualityData.prices, squad);
        evCache.set(qualityKey, qualityEv);
        evNoDataCache.delete(qualityKey);
        if (bestEv == null || qualityEv > bestEv) bestEv = qualityEv;
      }

      const bestKey = evCacheKey(group.key, squad, "best");
      if (bestEv != null) {
        evCache.set(bestKey, bestEv);
        evNoDataCache.delete(bestKey);
      } else if (!snapshot.transient) {
        evNoDataCache.set(bestKey, Date.now());
      }
    }

    if (snapshot.transient && !evCache.has(sentinelKey)) {
      evNoDataCache.set(sentinelKey, Date.now() - (EV_NODATA_TTL_MS - EV_TRANSIENT_MS));
    }
  } finally {
    groupPricePending.delete(group.key);
    evPending.delete(sentinelKey);
  }
}

// ---------------------------------------------------------------------------
// Warmup: relic EVs
// ---------------------------------------------------------------------------

export async function warmupRelicEvs(
  groups: RelicGroup[],
  onBatchDone: () => void,
  priority: RequestPriority = "normal",
): Promise<void> {
  if (warmupRunning) return;
  indexGroupsForPriceInvalidation(groups);
  warmupRunning = true;

  const token = ++warmupToken;

  try {
    for (;;) {
      if (token !== warmupToken) return;

      const now = Date.now();
      const queue: RelicGroup[] = [];

      for (const group of groups) {
        const key = evCacheKey(group.key, 1, "best");
        const noDataTs = evNoDataCache.get(key);
        if (evCache.has(key) || evPending.has(key)) continue;
        if (noDataTs && now - noDataTs < EV_NODATA_TTL_MS && !groupHasAnyCachedRewardPrice(group)) {
          continue;
        }
        queue.push(group);
        if (queue.length >= EV_BATCH_SIZE) break;
      }

      if (queue.length === 0) break;

      await Promise.all(
        Array.from({ length: EV_WORKERS }, async () => {
          for (;;) {
            if (token !== warmupToken) return;
            const group = queue.shift();
            if (!group) return;
            await computeGroupEv(group, priority);
          }
        }),
      );

      if (token === warmupToken) onBatchDone();
      await new Promise((resolve) => setTimeout(resolve, WARMUP_LOOP_PAUSE_MS));
    }
  } finally {
    if (token === warmupToken) {
      warmupRunning = false;
      onBatchDone();
    }
  }
}
