import type {
  FoundryData,
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
  RawInventoryEntry,
  Resource,
} from "../types/inventory.js";

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

interface ResolvedItem extends ItemDbEntry {
  name: string;
  imageUrl: string | null;
}

function resolveItem(
  internalName: string,
  itemDb: Record<string, ItemDbEntry>,
): ResolvedItem {
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
  name = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return { name, imageUrl: null, category: "Unknown" };
}

function inferCategory(
  internalName: string,
  defaultCat: string,
  dbEntry: ItemDbEntry = {},
): string {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return "amps";
  if (
    typeof dbEntry.productCategory === "string" &&
    PRODUCT_TO_FILTER[dbEntry.productCategory]
  ) {
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

export function parseInventory(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): ParsedItem[] {
  const items: ParsedItem[] = [];

  for (const { key, cat, label } of CATEGORIES) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries as RawInventoryEntry[]) {
      if (!entry?.ItemType) continue;

      const resolved = resolveItem(entry.ItemType, itemDb);
      const dbEntry = itemDb[entry.ItemType] || {};

      if (shouldHide(entry.ItemType, dbEntry, resolved)) continue;

      const finalCat = inferCategory(entry.ItemType, cat, dbEntry);
      const finalLabel = CATEGORIES.find((c) => c.cat === finalCat)?.label || label;
      const xp = typeof entry.XP === "number" ? entry.XP : 0;

      items.push({
        name: resolved.name,
        internalName: entry.ItemType,
        category: finalCat,
        categoryLabel: finalLabel,
        rank: xp > 0 ? Math.min(30, Math.floor(xp / 6000)) : 0,
        maxRank: 30,
        imageUrl: resolved.imageUrl ?? null,
        isPrime: resolved.isPrime ?? false,
        masteryReq: resolved.masteryReq ?? 0,
        vaulted: resolved.vaulted ?? false,
        tradable: dbEntry.tradable ?? resolved.isPrime ?? false,
        description: typeof dbEntry.description === "string" ? dbEntry.description : "",
        components: Array.isArray(dbEntry.components) ? dbEntry.components : [],
        drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
        wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      });
    }
  }

  return items;
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
    if (
      typeof dateValue === "object" &&
      dateValue !== null &&
      "$numberLong" in dateValue
    ) {
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
