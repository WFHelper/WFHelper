import type { InventoryGroup, ItemDbEntry, RawInventoryEntry } from "../../types/inventory.js";
import { MAX_ITEM_RANK, XP_PER_RANK } from "../../config/game.js";
import { toFiniteNumber } from "../../../config/shared/numeric.js";


const RANK_KEYS = new Set([
  "rank",
  "rnk",
  "level",
  "lvl",
  "lv",
  "modrank",
  "upgraderank",
  "upgradelvl",
  "fusionlevel",
  "currentrank",
  "currentlevel",
  "currentlvl",
  "itemlevel",
  "itemlvl",
  "arcanerank",
  "arcanelvl",
]);

const MAX_RANK_KEYS = new Set([
  "maxrank",
  "maxlevel",
  "maxlvl",
  "maxlv",
  "itemmaxrank",
  "maxupgraderank",
  "maxupgradelvl",
  "maxupgradelevel",
  "maxmodrank",
  "maxarcanelvl",
  "maxarcanelv",
  "maxarcanerank",
]);

const FINGERPRINT_RANK_KEYS = new Set([
  "lvl",
  "level",
  "rank",
  "modrank",
  "upgraderank",
  "upgradelvl",
  "fusionlevel",
  "currentrank",
  "currentlevel",
  "itemlevel",
  "arcanerank",
]);


export function pickNumeric(entry: RawInventoryEntry, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber((entry as Record<string, unknown>)[key]);
    if (value != null) return value;
  }
  return null;
}

export function deepFindNumericByKeys(
  value: unknown,
  keySet: Set<string>,
  maxDepth = 3,
  depth = 0,
): number | null {
  if (depth > maxDepth || value == null) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindNumericByKeys(item, keySet, maxDepth, depth + 1);
      if (found != null) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (keySet.has(normalized)) {
      const asNumber = toFiniteNumber(nested);
      if (asNumber != null) return asNumber;
    }
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    const found = deepFindNumericByKeys(nested, keySet, maxDepth, depth + 1);
    if (found != null) return found;
  }

  return null;
}

export function hasAnyRankSignal(value: unknown): boolean {
  if (value == null) return false;

  if (Array.isArray(value)) {
    return value.some((entry) => hasAnyRankSignal(entry));
  }

  if (typeof value !== "object") return false;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.includes("fingerprint")) {
      continue;
    }

    if (
      normalized.includes("rank") ||
      normalized.includes("level") ||
      normalized.includes("fusion")
    ) {
      const asNumber = toFiniteNumber(nested);
      if (asNumber != null && asNumber > 0) return true;
    }

    if (nested && typeof nested === "object" && hasAnyRankSignal(nested)) return true;
  }

  return false;
}


export function parseFingerprintPayload(raw: unknown): unknown {
  let current = raw;

  for (let i = 0; i < 3; i += 1) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed) return null;

    try {
      current = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }

  return current;
}

export function extractFingerprintRank(entry: RawInventoryEntry): number | null {
  const raw =
    (entry as Record<string, unknown>).UpgradeFingerprint ??
    (entry as Record<string, unknown>).upgradeFingerprint;
  if (raw == null) return null;

  const payload = parseFingerprintPayload(raw);
  if (!payload || typeof payload !== "object") return null;

  const record = payload as RawInventoryEntry;
  const rank =
    pickNumeric(record, [
      "lvl",
      "level",
      "rank",
      "ModRank",
      "FusionLevel",
      "UpgradeLevel",
      "CurrentLevel",
      "CurrentRank",
      "ArcaneRank",
      "ItemLevel",
      "ItemRank",
      "UpgradeRank",
    ]) ?? deepFindNumericByKeys(payload, FINGERPRINT_RANK_KEYS, 2);

  if (rank == null || rank < 0) return null;
  return Math.floor(rank);
}


export function normalizeRank(
  entry: RawInventoryEntry,
  group: InventoryGroup,
  dbEntry: ItemDbEntry,
): { rank: number; maxRank: number } {
  const dbMaxRank =
    pickNumeric(dbEntry as RawInventoryEntry, [
      "maxRank",
      "max_level",
      "maxLevel",
      "maxrank",
      "fusionLimit",
      "fusion_limit",
      "maxArcaneRank",
      "max_arcane_rank",
    ]) ?? deepFindNumericByKeys(dbEntry as Record<string, unknown>, MAX_RANK_KEYS);

  const explicitMaxRank =
    pickNumeric(entry, [
      "MaxRank",
      "ItemMaxRank",
      "UpgradeMax",
      "UpgradeMaxRank",
      "MaxUpgradeLevel",
      "MaxLevel",
      "MaxArcaneLevel",
    ]) ?? deepFindNumericByKeys(entry, MAX_RANK_KEYS);
  const fallbackMaxRank = group === "mods" ? 10 : group === "arcanes" ? 5 : MAX_ITEM_RANK;
  const maxRank =
    explicitMaxRank != null && explicitMaxRank > 0
      ? Math.floor(explicitMaxRank)
      : dbMaxRank != null && dbMaxRank > 0
        ? Math.floor(dbMaxRank)
        : fallbackMaxRank;

  const explicitRank =
    pickNumeric(entry, [
      "Rank",
      "ItemLevel",
      "Level",
      "ModRank",
      "FusionLevel",
      "UpgradeLevel",
      "CurrentLevel",
      "CurrentRank",
      "ArcaneRank",
      "ItemRank",
      "UpgradeRank",
    ]) ?? deepFindNumericByKeys(entry, RANK_KEYS);

  const fingerprintRank = explicitRank == null ? extractFingerprintRank(entry) : null;
  const resolvedRank = explicitRank ?? fingerprintRank;

  if (resolvedRank != null) {
    const rank = Math.max(0, Math.floor(resolvedRank));
    return { rank: Math.min(rank, maxRank), maxRank };
  }

  if (group === "mods" || group === "arcanes") {
    return { rank: 0, maxRank };
  }

  const xp = toFiniteNumber(entry.XP) || 0;
  const rank = xp > 0 ? Math.floor(xp / XP_PER_RANK) : 0;
  return { rank: Math.min(rank, maxRank), maxRank };
}
