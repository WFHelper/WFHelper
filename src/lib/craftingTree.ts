import type { ItemDbEntry, RecipeData } from "../types/inventory.js";

export interface CraftingTreeNode {
  uniqueName: string;
  name: string;
  imageUrl: string | null;
  count: number;
  owned: number;
  missing: number;
  isCraftable: boolean;
  recipe: RecipeData | null;
  usedFor: Array<{
    uniqueName: string;
    name: string;
    imageUrl: string | null;
  }>;
  children: CraftingTreeNode[];
}

interface CraftingTreeSummary {
  totalCredits: number;
  minBuildTime: number;
  maxBuildTime: number;
  blueprints: { uniqueName: string; name: string; count: number; owned: number }[];
  resources: { uniqueName: string; name: string; count: number; owned: number }[];
}

const MAX_DEPTH = 5;

/** Common resource path prefixes — never recurse into these sub-trees. */
const LEAF_RESOURCE_PREFIXES = ["/Lotus/Types/Items/MiscItems/", "/Lotus/Types/Items/Research/"];

/**
 * Build a crafting tree for the given item uniqueName.
 * Returns null if the item has no recipe.
 */
export function buildCraftingTree(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): CraftingTreeNode | null {
  const item = itemDb[uniqueName];
  if (!item?.recipe) return null;

  return buildNode(
    uniqueName,
    1,
    item.recipe,
    itemDb,
    ownership,
    0,
    findUsedFor(uniqueName, itemDb),
    new Set([uniqueName]),
  );
}

function isLeafResource(uniqueName: string): boolean {
  return LEAF_RESOURCE_PREFIXES.some((p) => uniqueName.startsWith(p));
}

function buildNode(
  uniqueName: string,
  count: number,
  recipe: RecipeData | null,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  depth: number,
  usedFor: CraftingTreeNode["usedFor"] = [],
  ancestors: Set<string> = new Set(),
): CraftingTreeNode {
  const item = itemDb[uniqueName];
  const name = item?.name || extractFallbackName(uniqueName);
  const imageUrl = item?.imageUrl || null;
  const owned = ownership.get(uniqueName) || 0;
  const missing = Math.max(0, count - owned);

  // Treat common resources as leaf nodes even if they have recipes
  const effectiveRecipe = isLeafResource(uniqueName) ? null : recipe;

  const children: CraftingTreeNode[] = [];
  if (effectiveRecipe && depth < MAX_DEPTH) {
    // Add blueprint as first child (it's needed to craft but not listed in ingredients)
    if (effectiveRecipe.blueprintUniqueName) {
      const bpUn = effectiveRecipe.blueprintUniqueName;
      const bpItem = itemDb[bpUn];
      const bpOwned = ownership.get(bpUn) || 0;
      children.push({
        uniqueName: bpUn,
        name: bpItem?.name || `${name} Blueprint`,
        imageUrl: bpItem?.imageUrl || null,
        count,
        owned: bpOwned,
        missing: Math.max(0, count - bpOwned),
        isCraftable: false,
        recipe: null,
        usedFor: [],
        children: [],
      });
    }

    for (const ing of aggregateIngredients(effectiveRecipe.ingredients)) {
      const ingItem = itemDb[ing.uniqueName];
      const ingRecipe = ingItem?.recipe || null;
      const nextCount = ing.count * count;
      if (ancestors.has(ing.uniqueName)) {
        children.push(buildNode(ing.uniqueName, nextCount, null, itemDb, ownership, depth + 1));
        continue;
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(ing.uniqueName);
      children.push(
        buildNode(
          ing.uniqueName,
          nextCount,
          ingRecipe,
          itemDb,
          ownership,
          depth + 1,
          [],
          nextAncestors,
        ),
      );
    }
  }

  return {
    uniqueName,
    name,
    imageUrl,
    count,
    owned,
    missing,
    isCraftable: effectiveRecipe !== null,
    recipe: effectiveRecipe,
    usedFor,
    children,
  };
}

function aggregateIngredients(ingredients: RecipeData["ingredients"]): RecipeData["ingredients"] {
  const byUniqueName = new Map<string, RecipeData["ingredients"][number]>();
  for (const ingredient of ingredients) {
    const existing = byUniqueName.get(ingredient.uniqueName);
    if (existing) {
      existing.count += ingredient.count;
    } else {
      byUniqueName.set(ingredient.uniqueName, { ...ingredient });
    }
  }
  return [...byUniqueName.values()];
}

function findUsedFor(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): CraftingTreeNode["usedFor"] {
  const seen = new Set<string>();
  const matches: CraftingTreeNode["usedFor"] = [];

  for (const [productUniqueName, entry] of Object.entries(itemDb)) {
    const ingredients = entry.recipe?.ingredients ?? [];
    if (!ingredients.some((ingredient) => ingredient.uniqueName === uniqueName)) continue;
    if (seen.has(productUniqueName)) continue;

    seen.add(productUniqueName);
    matches.push({
      uniqueName: productUniqueName,
      name: entry.name || extractFallbackName(productUniqueName),
      imageUrl: entry.imageUrl || null,
    });
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches;
}

/** Compute a summary of all leaf resources needed. */
export function computeCraftingSummary(tree: CraftingTreeNode): CraftingTreeSummary {
  let totalCredits = 0;
  let minBuildTime = 0;
  let maxBuildTime = 0;
  const blueprintMap = new Map<string, { name: string; count: number; owned: number }>();
  const resourceMap = new Map<string, { name: string; count: number; owned: number }>();

  function walk(node: CraftingTreeNode, depth: number): number {
    let subtreeTime = 0;
    if (node.recipe) {
      totalCredits += node.recipe.buildPrice;
      subtreeTime = node.recipe.buildTime;
    }

    if (node.children.length === 0 && !node.isCraftable) {
      // Leaf resource
      const existing = resourceMap.get(node.uniqueName);
      if (existing) {
        existing.count += node.count;
      } else {
        resourceMap.set(node.uniqueName, {
          name: node.name,
          count: node.count,
          owned: node.owned,
        });
      }
    } else {
      // Craftable item with children = blueprint
      if (depth > 0 && node.isCraftable) {
        const existing = blueprintMap.get(node.uniqueName);
        if (existing) {
          existing.count += node.count;
        } else {
          blueprintMap.set(node.uniqueName, {
            name: node.name,
            count: node.count,
            owned: node.owned,
          });
        }
      }

      let maxChildTime = 0;
      let totalChildTime = 0;
      for (const child of node.children) {
        const childTime = walk(child, depth + 1);
        maxChildTime = Math.max(maxChildTime, childTime);
        totalChildTime += childTime;
      }
      // Min = parallel crafting (max of children + own build)
      // Max = sequential crafting (sum of children + own build)
      if (depth === 0) {
        minBuildTime = subtreeTime + maxChildTime;
        maxBuildTime = subtreeTime + totalChildTime;
      } else {
        subtreeTime += maxChildTime;
      }
    }

    return subtreeTime;
  }

  walk(tree, 0);
  return {
    totalCredits,
    minBuildTime,
    maxBuildTime,
    blueprints: Array.from(blueprintMap.entries()).map(([uniqueName, r]) => ({
      uniqueName,
      ...r,
    })),
    resources: Array.from(resourceMap.entries()).map(([uniqueName, r]) => ({
      uniqueName,
      ...r,
    })),
  };
}

function extractFallbackName(uniqueName: string): string {
  const segments = uniqueName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return name;
}
