import {
  fetchPriceBySlug,
  onPriceCacheUpdate,
  type RequestPriority,
} from "./wfmPrice.js";
import { getCachedPriceState } from "./priceCache.js";
import type { RawInventoryData } from "../types/inventory.js";
import type {
  OwnedCounts,
  RelicDatabase,
  RelicGroup,
  RelicQuality,
  RelicQualityData,
  RelicReward,
} from "../types/relics.js";

export const RELIC_ICON_PATHS: Record<string, string> = {
  lith: "world-icons/relic-lith.png",
  meso: "world-icons/relic-meso.png",
  neo: "world-icons/relic-neo.png",
  axi: "world-icons/relic-axi.png",
  requiem: "world-icons/relic-requiem.png",
  omnia: "world-icons/relic-requiem.png",
  default: "world-icons/relic-lith.png",
};

export const RELIC_TIER_ORDER: Record<string, number> = {
  Lith: 0,
  Meso: 1,
  Neo: 2,
  Axi: 3,
  Requiem: 4,
};

const QUALITY_MODES: RelicQuality[] = [
  "intact",
  "exceptional",
  "flawless",
  "radiant",
];

const EV_NODATA_TTL_MS = 2 * 60 * 1000;
const EV_TRANSIENT_MS = 30_000;
const EV_BATCH_SIZE = 30;
const EV_WORKERS = 4;
const RELIC_CARD_NODATA_TTL_MS = 5 * 60 * 1000;
const RELIC_CARD_WARMUP_BATCH_SIZE = 48;
const RELIC_CARD_WARMUP_WORKERS = 3;
const PRIME_PRICE_WARMUP_BATCH_SIZE = 80;
const PRIME_PRICE_WARMUP_WORKERS = 4;
const WARMUP_LOOP_PAUSE_MS = 50;
const GROUP_PRICE_FETCH_WORKERS = 4;
const RELIC_RUNTIME_CACHE_KEY = "relic_runtime_cache_v1";
const RELIC_RUNTIME_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RELIC_RUNTIME_CACHE_SAVE_DEBOUNCE_MS = 2000;

export function fissureTierClass(tier: string = ""): string {
  const t = tier.toLowerCase();
  if (t.includes("lith")) return "lith";
  if (t.includes("meso")) return "meso";
  if (t.includes("neo")) return "neo";
  if (t.includes("axi")) return "axi";
  if (t.includes("requiem")) return "requiem";
  if (t.includes("omnia")) return "omnia";
  return "default";
}

export function parseOwnedRelics(
  inventoryData: RawInventoryData | null,
  relicDb: RelicDatabase | null,
): OwnedCounts {
  const owned: OwnedCounts = {};
  if (!inventoryData || !relicDb) return owned;

  const ensureOwnedSlot = (groupKey: string): void => {
    if (!owned[groupKey]) {
      owned[groupKey] = {
        intact: 0,
        exceptional: 0,
        flawless: 0,
        radiant: 0,
      };
    }
  };

  const addEntries = (entries: unknown): number => {
    if (!Array.isArray(entries)) return 0;
    let hits = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as { ItemType?: string; ItemCount?: number };
      if (!raw.ItemType) continue;

      const info = relicDb.byUniqueName[raw.ItemType];
      if (!info) continue;

      ensureOwnedSlot(info.groupKey);
      const count = typeof raw.ItemCount === "number" ? raw.ItemCount : 1;
      owned[info.groupKey][info.quality] += count;
      hits += count;
    }
    return hits;
  };

  // Primary source from API-helper and many inventory exports.
  let totalHits = addEntries(inventoryData.LevelKeys);
  if (totalHits > 0) return owned;

  // Fallback for AlecaFrame/other exporters where relics can live in
  // different arrays (e.g. MiscItems). Only used when LevelKeys is empty.
  for (const value of Object.values(inventoryData)) {
    totalHits += addEntries(value);
  }

  return owned;
}

export function computeSquadEV(
  rewards: Array<{ chance: number }>,
  prices: Array<number | null>,
  N: number,
): number {
  const items = rewards.map((r, i) => ({ prob: r.chance / 100, price: prices[i] ?? 0 }));

  if (N <= 1) {
    return items.reduce((sum, item) => sum + item.prob * item.price, 0);
  }

  const sorted = [...items].sort((a, b) => a.price - b.price);
  const grouped: Array<{ price: number; prob: number }> = [];
  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.price === item.price) {
      last.prob += item.prob;
    } else {
      grouped.push({ price: item.price, prob: item.prob });
    }
  }

  let ev = 0;
  let cdfPrev = 0;
  for (const g of grouped) {
    const cdfCur = Math.min(1, cdfPrev + g.prob);
    ev += g.price * (Math.pow(cdfCur, N) - Math.pow(cdfPrev, N));
    cdfPrev = cdfCur;
  }
  return ev;
}

const evCache = new Map<string, number>();
const evNoDataCache = new Map<string, number>();
const evPending = new Set<string>();
const groupPriceCache = new Map<string, GroupPriceSnapshot>();
const groupPricePending = new Set<string>();
const relicCardPriceCache = new Map<string, number>();
const relicCardPricePending = new Set<string>();
const relicCardNoDataCache = new Map<string, number>();
const primeRewardWarmupComplete = new Set<string>();
const rewardSlugToGroups = new Map<string, Set<string>>();

let runtimeCacheDirty = false;
let runtimeCacheTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeCacheHydrated = false;
let activeRuntimeFingerprint: string | null = null;
let hydratedRuntimeFingerprint: string | null = null;

let warmupRunning = false;
let warmupToken = 0;
let cardWarmupRunning = false;
let cardWarmupToken = 0;
let primeWarmupRunning = false;
let primeWarmupToken = 0;

interface QualityPriceData {
  rewards: RelicReward[];
  prices: Array<number | null>;
  hasAnyPrice: boolean;
}

interface GroupPriceSnapshot {
  transient: boolean;
  qualities: Partial<Record<RelicQuality, QualityPriceData>>;
}

interface PersistedRelicRuntimeCache {
  v: 1;
  savedAt: number;
  fingerprint: string | null;
  evEntries: Array<[key: string, value: number]>;
  cardPriceEntries: Array<[groupKey: string, value: number]>;
}

export interface RelicRuntimeCacheStats {
  evEntries: number;
  cardPriceEntries: number;
  evNoDataEntries: number;
  cardNoDataEntries: number;
  fingerprint: string | null;
}

function storageOrNull(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function fnv1aStep(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h +=
      (h << 1) +
      (h << 4) +
      (h << 7) +
      (h << 8) +
      (h << 24);
  }
  return h >>> 0;
}

function computeRelicDbFingerprint(db: RelicDatabase): string {
  let hash = 0x811c9dc5;
  const groups = Object.values(db.groups || {}).sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  hash = fnv1aStep(hash, `groups:${groups.length}`);

  for (const group of groups) {
    hash = fnv1aStep(hash, `g:${group.key}|${group.tier}|${group.code}`);
    const qualityEntries = Object.entries(group.qualities || {}).sort((a, b) =>
      a[0].localeCompare(b[0]),
    ) as Array<[RelicQuality, RelicQualityData]>;

    for (const [quality, qData] of qualityEntries) {
      hash = fnv1aStep(hash, `q:${quality}|${qData.uniqueName || ""}`);
      const rewardSlugs = (qData.rewards || [])
        .map((reward) => reward?.urlName || "")
        .sort();
      hash = fnv1aStep(hash, `r:${rewardSlugs.join(",")}`);
    }
  }

  return `f${hash.toString(16).padStart(8, "0")}`;
}

function markRuntimeCacheDirty(): void {
  runtimeCacheDirty = true;
  if (runtimeCacheTimer) return;

  runtimeCacheTimer = setTimeout(() => {
    runtimeCacheTimer = null;
    if (!runtimeCacheDirty) return;
    persistRuntimeCache();
  }, RELIC_RUNTIME_CACHE_SAVE_DEBOUNCE_MS);
}

function persistRuntimeCache(): void {
  runtimeCacheDirty = false;
  const storage = storageOrNull();
  if (!storage) return;

  try {
    const payload: PersistedRelicRuntimeCache = {
      v: 1,
      savedAt: Date.now(),
      fingerprint: activeRuntimeFingerprint,
      evEntries: [...evCache.entries()],
      cardPriceEntries: [...relicCardPriceCache.entries()],
    };
    storage.setItem(RELIC_RUNTIME_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("[Relic] Failed to persist runtime cache:", e);
  }
}

function hydrateRuntimeCache(): void {
  runtimeCacheHydrated = true;
  const storage = storageOrNull();
  if (!storage) return;
  try {
    const raw = storage.getItem(RELIC_RUNTIME_CACHE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw) as PersistedRelicRuntimeCache;
    if (parsed.v !== 1 || !Number.isFinite(parsed.savedAt)) return;
    hydratedRuntimeFingerprint = parsed.fingerprint ?? null;

    const ageMs = Date.now() - parsed.savedAt;
    if (ageMs > RELIC_RUNTIME_CACHE_TTL_MS) return;

    for (const [key, value] of parsed.evEntries || []) {
      if (typeof key === "string" && Number.isFinite(value)) {
        evCache.set(key, value);
      }
    }

    for (const [groupKey, value] of parsed.cardPriceEntries || []) {
      if (typeof groupKey === "string" && Number.isFinite(value)) {
        relicCardPriceCache.set(groupKey, value);
      }
    }

  } catch (e) {
    console.warn("[Relic] Failed to hydrate runtime cache:", e);
  }
}

export function flushRelicRuntimeCache(): void {
  if (runtimeCacheTimer) {
    clearTimeout(runtimeCacheTimer);
    runtimeCacheTimer = null;
  }
  if (!runtimeCacheDirty) return;
  persistRuntimeCache();
}

export function configureRelicRuntimeCacheFingerprint(
  db: RelicDatabase | null | undefined,
): void {
  if (!db) return;

  const nextFingerprint = computeRelicDbFingerprint(db);
  if (activeRuntimeFingerprint === nextFingerprint) return;
  activeRuntimeFingerprint = nextFingerprint;

  if (!runtimeCacheHydrated) return;
  if (hydratedRuntimeFingerprint === nextFingerprint) return;

  evCache.clear();
  evNoDataCache.clear();
  groupPriceCache.clear();
  relicCardPriceCache.clear();
  relicCardNoDataCache.clear();
  primeRewardWarmupComplete.clear();
  rewardSlugToGroups.clear();
  hydratedRuntimeFingerprint = nextFingerprint;

  try {
    const storage = storageOrNull();
    storage?.removeItem(RELIC_RUNTIME_CACHE_KEY);
  } catch {
    // ignore storage failures here
  }
}

export function getRelicRuntimeCacheStats(): RelicRuntimeCacheStats {
  return {
    evEntries: evCache.size,
    cardPriceEntries: relicCardPriceCache.size,
    evNoDataEntries: evNoDataCache.size,
    cardNoDataEntries: relicCardNoDataCache.size,
    fingerprint: activeRuntimeFingerprint,
  };
}

function clearGroupEvCaches(groupKey: string): void {
  let changed = false;
  if (groupPriceCache.delete(groupKey)) changed = true;

  for (let squad = 1; squad <= 4; squad += 1) {
    if (evCache.delete(evCacheKey(groupKey, squad, "best"))) changed = true;
    if (evNoDataCache.delete(evCacheKey(groupKey, squad, "best"))) changed = true;

    for (const quality of QUALITY_MODES) {
      if (evCache.delete(evCacheKey(groupKey, squad, quality))) changed = true;
      if (evNoDataCache.delete(evCacheKey(groupKey, squad, quality))) changed = true;
    }
  }

  if (changed) markRuntimeCacheDirty();
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

hydrateRuntimeCache();

onPriceCacheUpdate((slug, status) => {
  if (status !== "ok") return;
  const affectedGroups = rewardSlugToGroups.get(slug);
  if (!affectedGroups) return;
  for (const groupKey of affectedGroups) {
    clearGroupEvCaches(groupKey);
  }
});

export function evCacheKey(
  groupKey: string,
  squadSize: number,
  qualityMode: string,
): string {
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

export function resetEvCaches(): void {
  evCache.clear();
  evNoDataCache.clear();
  evPending.clear();
  groupPriceCache.clear();
  groupPricePending.clear();
  relicCardPriceCache.clear();
  relicCardPricePending.clear();
  relicCardNoDataCache.clear();
  primeRewardWarmupComplete.clear();
  rewardSlugToGroups.clear();
  markRuntimeCacheDirty();
  warmupToken += 1;
  warmupRunning = false;
  cardWarmupToken += 1;
  cardWarmupRunning = false;
  primeWarmupToken += 1;
  primeWarmupRunning = false;
}

export function cancelWarmup(): void {
  warmupToken += 1;
  warmupRunning = false;
  cardWarmupToken += 1;
  cardWarmupRunning = false;
}

function relicGroupSlug(groupKey: string): string {
  const normalized = groupKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${normalized}_relic`;
}

export function getCachedRelicCardPrice(groupKey: string): number | null {
  return relicCardPriceCache.get(groupKey) ?? null;
}

export async function prefetchRelicCardPrice(
  groupKey: string,
  priority: RequestPriority = "normal",
): Promise<boolean> {
  const noDataTs = relicCardNoDataCache.get(groupKey);
  if (
    noDataTs &&
    Date.now() - noDataTs < RELIC_CARD_NODATA_TTL_MS
  ) {
    return false;
  }

  if (
    !groupKey ||
    relicCardPriceCache.has(groupKey) ||
    relicCardPricePending.has(groupKey)
  ) {
    return false;
  }

  relicCardPricePending.add(groupKey);
  try {
    let changed = false;
    const result = await fetchPriceBySlug(relicGroupSlug(groupKey), { priority });
    if (result.status === "ok" && result.median != null) {
      const existing = relicCardPriceCache.get(groupKey);
      if (existing !== result.median) {
        relicCardPriceCache.set(groupKey, result.median);
        changed = true;
      }
      if (relicCardNoDataCache.delete(groupKey)) {
        changed = true;
      }
      if (changed) markRuntimeCacheDirty();
      return true;
    }
    if (result.status === "no_data") {
      relicCardNoDataCache.set(groupKey, Date.now());
      markRuntimeCacheDirty();
    }
    return false;
  } finally {
    relicCardPricePending.delete(groupKey);
  }
}

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

    const prices = results.map((result) =>
      result.status === "ok" ? result.median : null,
    );
    snapshot.qualities[qualityName] = {
      rewards,
      prices,
      hasAnyPrice: prices.some((price) => price != null),
    };
  }

  return snapshot;
}

export async function computeGroupEv(
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
    let changed = false;
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
            changed = true;
          }
          continue;
        }

        const qualityEv = computeSquadEV(
          qualityData.rewards,
          qualityData.prices,
          squad,
        );
        const prevQualityEv = evCache.get(qualityKey);
        if (prevQualityEv !== qualityEv) {
          evCache.set(qualityKey, qualityEv);
          changed = true;
        }
        if (evNoDataCache.delete(qualityKey)) {
          changed = true;
        }
        if (bestEv == null || qualityEv > bestEv) bestEv = qualityEv;
      }

      const bestKey = evCacheKey(group.key, squad, "best");
      if (bestEv != null) {
        const prevBestEv = evCache.get(bestKey);
        if (prevBestEv !== bestEv) {
          evCache.set(bestKey, bestEv);
          changed = true;
        }
        if (evNoDataCache.delete(bestKey)) {
          changed = true;
        }
      } else if (!snapshot.transient) {
        evNoDataCache.set(bestKey, Date.now());
        changed = true;
      }
    }

    if (snapshot.transient && !evCache.has(sentinelKey)) {
      evNoDataCache.set(
        sentinelKey,
        Date.now() - (EV_NODATA_TTL_MS - EV_TRANSIENT_MS),
      );
      changed = true;
    }

    if (changed) {
      markRuntimeCacheDirty();
    }
  } finally {
    groupPricePending.delete(group.key);
    evPending.delete(sentinelKey);
  }
}

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
        if (
          noDataTs &&
          now - noDataTs < EV_NODATA_TTL_MS &&
          !groupHasAnyCachedRewardPrice(group)
        ) {
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

