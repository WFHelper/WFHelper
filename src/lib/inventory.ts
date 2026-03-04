import type {
  FoundryData,
  InventoryGroup,
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
  RawInventoryEntry,
  Resource,
} from "../types/inventory.js";
import { MAX_ITEM_RANK, XP_PER_RANK } from "../config/game.js";

interface CategoryDef {
  key: keyof RawInventoryData;
  cat: string;
  label: string;
}

const CATEGORIES: CategoryDef[] = [
  { key: "Suits", cat: "warframes", label: "Warframe" },
  { key: "LongGuns", cat: "primary", label: "Primary" },
  { key: "Pistols", cat: "secondary", label: "Secondary" },
  { key: "Melee", cat: "melee", label: "Melee" },
  { key: "Sentinels", cat: "companions", label: "Companion" },
  { key: "SentinelWeapons", cat: "companions", label: "Companion" },
  { key: "SpaceSuits", cat: "archwing", label: "Archwing" },
  { key: "SpaceGuns", cat: "archwing", label: "Archwing" },
  { key: "SpaceMelee", cat: "archwing", label: "Archwing" },
  { key: "OperatorAmps", cat: "amps", label: "Amp" },
  { key: "MechSuits", cat: "necramech", label: "Necramech" },
];

const PRODUCT_TO_FILTER: Record<string, string> = {
  Suits: "warframes",
  LongGuns: "primary",
  Pistols: "secondary",
  Melee: "melee",
  Sentinels: "companions",
  SentinelWeapons: "companions",
  SpaceSuits: "archwing",
  SpaceGuns: "archwing",
  SpaceMelee: "archwing",
  OperatorAmps: "amps",
  MechSuits: "necramech",
};

const BASE_COLLECTION_KEYS = new Set(CATEGORIES.map((entry) => String(entry.key)));
const EXCLUDED_COLLECTION_KEYS = new Set(["InventoryJson", "PendingRecipes", "Recipes"]);

const GROUP_PRIORITY: Record<InventoryGroup, number> = {
  misc: 1,
  all_parts: 2,
  arcanes: 3,
  mods: 4,
  relics: 5,
  full_sets: 6,
};

const RANK_KEYS = new Set([
  "rank",
  "level",
  "modrank",
  "upgraderank",
  "fusionlevel",
  "currentrank",
  "currentlevel",
  "itemlevel",
  "arcanerank",
]);

const MAX_RANK_KEYS = new Set([
  "maxrank",
  "maxlevel",
  "itemmaxrank",
  "maxupgraderank",
  "maxmodrank",
  "maxarcanelvl",
  "maxarcanelv",
  "maxarcanerank",
]);

const EQUIP_CONTEXT_KEYS = new Set([
  "equippedon",
  "installedon",
  "slot",
  "slotname",
  "loadout",
  "loadoutname",
  "ownername",
  "hostitemname",
  "parentname",
  "weaponname",
  "warframename",
  "companionname",
]);

function isArcaneUpgrade(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/Arcanes?\//i.test(internalName)) return true;
  if (/\/CosmeticEnhancers?\//i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (category.includes("arcane")) return true;
  if (type.includes("arcane")) return true;
  if (name.startsWith("arcane ")) return true;

  return false;
}

function isFocusUpgrade(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/Upgrades\/Focus\//i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (type.includes("focus way")) return true;
  if (category.includes("focus")) return true;
  if (name.includes("waybound")) return true;

  return false;
}

interface ResolvedItem extends ItemDbEntry {
  name: string;
  imageUrl: string | null;
}

function resolveItem(internalName: string, itemDb: Record<string, ItemDbEntry>): ResolvedItem {
  const dbEntry = itemDb[internalName];
  if (dbEntry?.name) {
    return {
      ...dbEntry,
      name: dbEntry.name,
      imageUrl: dbEntry.imageUrl ?? null,
    };
  }
  if (!internalName) return { name: "Unknown", imageUrl: null };

  const segments = internalName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return { name, imageUrl: null, category: "Unknown" };
}

function inferCategory(
  internalName: string,
  defaultCat: string,
  dbEntry: ItemDbEntry = {},
): string {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return "amps";
  if (typeof dbEntry.productCategory === "string" && PRODUCT_TO_FILTER[dbEntry.productCategory]) {
    return PRODUCT_TO_FILTER[dbEntry.productCategory];
  }
  return defaultCat;
}

function shouldHide(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (dbEntry.exalted === true) return true;
  if (dbEntry.productCategory === "SpecialItems") return true;
  if (typeof dbEntry.type === "string" && /exalted/i.test(dbEntry.type)) {
    return true;
  }
  if (
    /^(Exalted Blade|Regulators(?: Prime)?|Iron Staff(?: Prime)?|Dex Pixia(?: Prime)?|Artemis Bow(?: Prime)?|Desert Wind(?: Prime)?)$/i.test(
      resolved.name,
    )
  ) {
    return true;
  }
  if (/\/ExaltedWeapons?\//.test(internalName)) return true;
  if (/\/SpecialItems\//.test(internalName)) return true;
  return false;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickNumeric(entry: RawInventoryEntry, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber((entry as Record<string, unknown>)[key]);
    if (value != null) return value;
  }
  return null;
}

function pickBoolean(entry: RawInventoryEntry, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
    }
  }
  return undefined;
}

function deepFindNumericByKeys(
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

function hasAnyRankSignal(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasAnyRankSignal(entry));
  }
  if (typeof value !== "object") return false;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (
      normalized.includes("rank") ||
      normalized.includes("level") ||
      normalized.includes("upgrade") ||
      normalized.includes("fusion")
    ) {
      const asNumber = toFiniteNumber(nested);
      if (asNumber != null && asNumber > 0) return true;
    }
    if (hasAnyRankSignal(nested)) return true;
  }

  return false;
}

function isDisplayableEquipContext(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 60) return false;
  if (trimmed.startsWith("/Lotus/")) return false;
  if (/^[A-Za-z]:\\/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
}

function collectEquipContexts(
  value: unknown,
  contexts: Set<string>,
  maxDepth = 3,
  depth = 0,
): void {
  if (depth > maxDepth || value == null) return;

  if (typeof value === "string") {
    if (isDisplayableEquipContext(value)) {
      contexts.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEquipContexts(entry, contexts, maxDepth, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (EQUIP_CONTEXT_KEYS.has(normalized)) {
      if (typeof nested === "string" && isDisplayableEquipContext(nested)) {
        contexts.add(nested.trim());
      } else if (Array.isArray(nested)) {
        for (const part of nested) {
          if (typeof part === "string" && isDisplayableEquipContext(part)) {
            contexts.add(part.trim());
          }
        }
      }
    }
    collectEquipContexts(nested, contexts, maxDepth, depth + 1);
  }
}

function extractEquipContexts(entry: RawInventoryEntry): string[] {
  const contexts = new Set<string>();
  collectEquipContexts(entry, contexts);
  return [...contexts].slice(0, 4);
}

function normalizeCollectionEntries(value: unknown, maxDepth = 4, depth = 0): RawInventoryEntry[] {
  if (depth > maxDepth || value == null) return [];

  if (Array.isArray(value)) {
    const flattened: RawInventoryEntry[] = [];
    for (const entry of value) {
      flattened.push(...normalizeCollectionEntries(entry, maxDepth, depth + 1));
    }
    return flattened;
  }

  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (typeof record.ItemType === "string") {
    return [record as RawInventoryEntry];
  }

  const flattened: RawInventoryEntry[] = [];
  for (const nested of Object.values(record)) {
    flattened.push(...normalizeCollectionEntries(nested, maxDepth, depth + 1));
  }
  return flattened;
}

function inferCollectionDefaults(key: string): { cat: string; label: string } {
  if (key === "LevelKeys") return { cat: "relics", label: "Relic" };
  if (key === "Upgrades") return { cat: "mods", label: "Mod" };
  if (key === "Arcanes") return { cat: "arcanes", label: "Arcane" };
  if (key === "MiscItems") return { cat: "misc", label: "Misc" };

  const label = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();

  return {
    cat: "misc",
    label: label || "Misc",
  };
}

function deriveGroup(
  sourceKey: string,
  internalName: string,
  dbEntry: ItemDbEntry,
  resolved: ResolvedItem,
): InventoryGroup {
  if (isFocusUpgrade(internalName, dbEntry, resolved)) return "misc";

  if (sourceKey === "LevelKeys") return "relics";
  if (sourceKey === "Arcanes") return "arcanes";
  if (sourceKey === "Upgrades") {
    return isArcaneUpgrade(internalName, dbEntry, resolved) ? "arcanes" : "mods";
  }

  if (/\/Relics?\//i.test(internalName)) return "relics";
  if (isArcaneUpgrade(internalName, dbEntry, resolved)) return "arcanes";

  const category = String(dbEntry.category || "").toLowerCase();
  if (category.includes("relic")) return "relics";
  if (category.includes("arcane")) return "arcanes";
  if (category.includes("mod")) return "mods";

  const type = String(dbEntry.type || "").toLowerCase();
  if (type.includes("arcane")) return "arcanes";
  if (type.includes("mod")) return "mods";

  if (dbEntry.tradable === true || resolved.isPrime === true) return "all_parts";
  return "misc";
}

function normalizeRank(
  entry: RawInventoryEntry,
  group: InventoryGroup,
): { rank: number; maxRank: number } {
  const explicitMaxRank =
    pickNumeric(entry, ["MaxRank", "ItemMaxRank", "UpgradeMax", "MaxLevel"]) ??
    deepFindNumericByKeys(entry, MAX_RANK_KEYS);
  const fallbackMaxRank = group === "mods" ? 10 : group === "arcanes" ? 5 : MAX_ITEM_RANK;
  const maxRank =
    explicitMaxRank != null && explicitMaxRank > 0 ? Math.floor(explicitMaxRank) : fallbackMaxRank;

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
    ]) ?? deepFindNumericByKeys(entry, RANK_KEYS);

  if (explicitRank != null) {
    const rank = Math.max(0, Math.floor(explicitRank));
    return { rank: Math.min(rank, maxRank), maxRank };
  }

  const xp = toFiniteNumber(entry.XP) || 0;
  const rank = xp > 0 ? Math.floor(xp / XP_PER_RANK) : 0;
  return { rank: Math.min(rank, maxRank), maxRank };
}

function parseAmount(entry: RawInventoryEntry): number {
  const raw =
    pickNumeric(entry, ["ItemCount", "Count", "StackCount", "Quantity"]) ??
    deepFindNumericByKeys(entry, new Set(["itemcount", "count", "stackcount", "quantity"])) ??
    1;
  return raw > 0 ? Math.floor(raw) : 1;
}

function preferGroup(current: InventoryGroup | undefined, next: InventoryGroup): InventoryGroup {
  if (!current) return next;
  return GROUP_PRIORITY[next] > GROUP_PRIORITY[current] ? next : current;
}

function mergeOptionalBoolean(
  current: boolean | undefined,
  next: boolean | undefined,
): boolean | undefined {
  if (current === true || next === true) return true;
  if (current === false || next === false) return false;
  return undefined;
}

function mergeEquipContexts(
  current: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>();
  for (const value of current || []) {
    if (isDisplayableEquipContext(value)) merged.add(value.trim());
  }
  for (const value of next || []) {
    if (isDisplayableEquipContext(value)) merged.add(value.trim());
  }
  const result = [...merged].slice(0, 6);
  return result.length > 0 ? result : undefined;
}

function buildFullSetItems(
  itemDb: Record<string, ItemDbEntry>,
  ownedCounts: Map<string, number>,
): ParsedItem[] {
  const setItems: ParsedItem[] = [];

  for (const [uniqueName, dbEntry] of Object.entries(itemDb)) {
    const components = Array.isArray(dbEntry.components) ? dbEntry.components : [];
    if (dbEntry.tradable !== true || components.length === 0) continue;

    const tradableComponents = components.filter(
      (component) => component.uniqueName && component.tradable !== false,
    );
    if (tradableComponents.length === 0) continue;

    let hasAnyOwned = false;
    let completeSets = Number.POSITIVE_INFINITY;

    const hydratedComponents = tradableComponents.map((component) => {
      const unique = component.uniqueName || "";
      const required =
        typeof component.itemCount === "number" && component.itemCount > 0
          ? component.itemCount
          : 1;
      const ownedCount = ownedCounts.get(unique) || 0;
      if (ownedCount > 0) hasAnyOwned = true;
      completeSets = Math.min(completeSets, Math.floor(ownedCount / required));

      return {
        ...component,
        ownedCount,
        owned: ownedCount >= required,
      };
    });

    const rootOwned = ownedCounts.get(uniqueName) || 0;
    if (!hasAnyOwned && rootOwned <= 0) continue;

    if (!Number.isFinite(completeSets)) completeSets = 0;

    const resolved = resolveItem(uniqueName, itemDb);
    const setName = resolved.name.endsWith(" Set") ? resolved.name : `${resolved.name} Set`;
    const isPrime = resolved.isPrime === true || /\bPrime\b/.test(resolved.name);

    setItems.push({
      name: setName,
      internalName: `${uniqueName}#set`,
      category: "full_sets",
      categoryLabel: "Full Set",
      rank: 0,
      maxRank: 1,
      imageUrl: resolved.imageUrl ?? null,
      isPrime,
      masteryReq: resolved.masteryReq ?? 0,
      vaulted: resolved.vaulted ?? false,
      tradable: true,
      description: typeof dbEntry.description === "string" ? dbEntry.description : "",
      components: hydratedComponents,
      drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
      wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      amount: completeSets,
      completeSets,
      partType: isPrime ? "prime" : "normal",
      inventoryGroup: "full_sets",
      leveledUp: false,
      keywords: ["set", "full set", resolved.name.toLowerCase()],
    });
  }

  return setItems;
}

export function parseInventory(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): ParsedItem[] {
  const itemMap = new Map<string, ParsedItem>();

  const addEntry = (
    entry: RawInventoryEntry,
    sourceKey: string,
    defaultCat: string,
    defaultLabel: string,
  ): void => {
    if (!entry?.ItemType) return;

    const internalName = entry.ItemType;
    const resolved = resolveItem(internalName, itemDb);
    const dbEntry = itemDb[internalName] || {};

    if (shouldHide(internalName, dbEntry, resolved)) return;

    const group = deriveGroup(sourceKey, internalName, dbEntry, resolved);
    let finalCat = inferCategory(internalName, defaultCat, dbEntry);
    let finalLabel = CATEGORIES.find((c) => c.cat === finalCat)?.label || defaultLabel;

    if (group === "arcanes") {
      finalCat = "arcanes";
      finalLabel = "Arcane";
    } else if (group === "mods") {
      finalCat = "mods";
      finalLabel = "Mod";
    } else if (group === "relics") {
      finalCat = "relics";
      finalLabel = "Relic";
    } else if (isFocusUpgrade(internalName, dbEntry, resolved)) {
      finalCat = "misc";
      finalLabel = "Focus";
    }

    const { rank, maxRank } = normalizeRank(entry, group);
    const amount = parseAmount(entry);
    const leveledSignal = hasAnyRankSignal(entry);
    const equippedIn = extractEquipContexts(entry);
    const favorite = pickBoolean(entry, ["Favorite", "IsFavorite", "favorite", "isFavorite"]);
    const equipped = pickBoolean(entry, [
      "Equipped",
      "IsEquipped",
      "Installed",
      "IsInstalled",
      "InUse",
    ]);
    const inferredEquipped =
      equipped !== undefined ? equipped : equippedIn.length > 0 ? true : undefined;

    const nextItem: ParsedItem = {
      name: resolved.name,
      internalName,
      category: finalCat,
      categoryLabel: finalLabel,
      rank,
      maxRank,
      imageUrl: resolved.imageUrl ?? null,
      isPrime: resolved.isPrime ?? false,
      partType: resolved.isPrime ? "prime" : "normal",
      masteryReq: resolved.masteryReq ?? 0,
      vaulted: resolved.vaulted ?? false,
      tradable: dbEntry.tradable ?? resolved.isPrime ?? false,
      amount,
      inventoryGroup: group,
      leveledUp: rank > 0 || leveledSignal,
      description: typeof dbEntry.description === "string" ? dbEntry.description : "",
      components: Array.isArray(dbEntry.components) ? dbEntry.components : [],
      drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
      wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      keywords: [sourceKey.toLowerCase()],
    };

    if (favorite !== undefined) nextItem.favorite = favorite;
    if (inferredEquipped !== undefined) nextItem.equipped = inferredEquipped;
    if (equippedIn.length > 0) nextItem.equippedIn = equippedIn;

    const existing = itemMap.get(internalName);
    if (!existing) {
      itemMap.set(internalName, nextItem);
      return;
    }

    existing.amount = (existing.amount || 0) + (nextItem.amount || 0);
    existing.rank = Math.max(existing.rank, nextItem.rank);
    existing.maxRank = Math.max(existing.maxRank, nextItem.maxRank);
    existing.leveledUp = Boolean(existing.leveledUp || nextItem.leveledUp);
    const mergedFavorite = mergeOptionalBoolean(existing.favorite, nextItem.favorite);
    if (mergedFavorite !== undefined) {
      existing.favorite = mergedFavorite;
    }
    const mergedEquipped = mergeOptionalBoolean(existing.equipped, nextItem.equipped);
    if (mergedEquipped !== undefined) {
      existing.equipped = mergedEquipped;
    }
    const mergedEquippedIn = mergeEquipContexts(existing.equippedIn, nextItem.equippedIn);
    if (mergedEquippedIn) {
      existing.equippedIn = mergedEquippedIn;
    }
    existing.inventoryGroup = preferGroup(
      existing.inventoryGroup,
      nextItem.inventoryGroup || "misc",
    );

    if (existing.category === "misc" && nextItem.category !== "misc") {
      existing.category = nextItem.category;
      existing.categoryLabel = nextItem.categoryLabel;
    }

    if (Array.isArray(existing.keywords)) {
      const nextKeywords = Array.isArray(nextItem.keywords) ? nextItem.keywords : [];
      for (const keyword of nextKeywords) {
        if (!existing.keywords.includes(keyword)) {
          existing.keywords.push(keyword);
        }
      }
    }
  };

  for (const { key, cat, label } of CATEGORIES) {
    const entries = normalizeCollectionEntries(data[key]);
    if (entries.length === 0) continue;
    for (const entry of entries) {
      addEntry(entry, String(key), cat, label);
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (BASE_COLLECTION_KEYS.has(key) || EXCLUDED_COLLECTION_KEYS.has(key)) continue;

    const entries = normalizeCollectionEntries(value);
    if (entries.length === 0) continue;

    const defaults = inferCollectionDefaults(key);
    for (const entry of entries) {
      addEntry(entry, key, defaults.cat, defaults.label);
    }
  }

  const ownedCounts = new Map<string, number>();
  for (const [internalName, item] of itemMap) {
    ownedCounts.set(internalName, item.amount || 0);
  }

  return [...itemMap.values(), ...buildFullSetItems(itemDb, ownedCounts)];
}

function parseCompletionDate(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "object") {
    const dateValue =
      (value as { $date?: { $numberLong?: string } | string | number }).$date ?? value;
    if (typeof dateValue === "object" && dateValue !== null && "$numberLong" in dateValue) {
      const ms = Number((dateValue as { $numberLong: string }).$numberLong);
      if (Number.isFinite(ms)) return new Date(ms);
      return null;
    }
    const date = new Date(dateValue as string | number);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function parseFoundry(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): FoundryData {
  const building: FoundryData["building"] = [];
  const recipes: FoundryData["recipes"] = [];

  for (const recipe of data.PendingRecipes || []) {
    if (!recipe?.ItemType) continue;
    const resolved = resolveItem(recipe.ItemType, itemDb);
    building.push({
      name: resolved.name,
      imageUrl: resolved.imageUrl ?? null,
      endDate: parseCompletionDate(recipe.CompletionDate),
    });
  }

  for (const recipe of data.Recipes || []) {
    if (!recipe?.ItemType) continue;
    const resolved = resolveItem(recipe.ItemType, itemDb);
    recipes.push({
      name: resolved.name,
      imageUrl: resolved.imageUrl ?? null,
      count: typeof recipe.ItemCount === "number" ? recipe.ItemCount : 1,
    });
  }

  return { building, recipes };
}

export function parseResources(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): Resource[] {
  const resources = (data.MiscItems || []).map((item) => {
    const internalName = item.ItemType || "";
    const resolved = resolveItem(internalName, itemDb);
    return {
      name: resolved.name,
      imageUrl: resolved.imageUrl ?? null,
      internalName,
      count: typeof item.ItemCount === "number" ? item.ItemCount : 0,
    };
  });

  return resources.sort((a, b) => b.count - a.count);
}
