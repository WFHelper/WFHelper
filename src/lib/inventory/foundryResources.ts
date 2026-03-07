import type {
  FoundryData,
  ItemDbEntry,
  RawInventoryData,
  Resource,
} from "../../types/inventory.js";
import { resolveItem } from "./itemClassification.js";

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
