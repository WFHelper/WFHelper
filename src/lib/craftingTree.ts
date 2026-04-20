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
  children: CraftingTreeNode[];
}

export interface CraftingTreeSummary {
  totalCredits: number;
  totalBuildTime: number;
  resources: { uniqueName: string; name: string; count: number; owned: number }[];
}

const MAX_DEPTH = 5;

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

  return buildNode(uniqueName, 1, item.recipe, itemDb, ownership, 0);
}

function buildNode(
  uniqueName: string,
  count: number,
  recipe: RecipeData | null,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  depth: number,
): CraftingTreeNode {
  const item = itemDb[uniqueName];
  const name = item?.name || extractFallbackName(uniqueName);
  const imageUrl = item?.imageUrl || null;
  const owned = ownership.get(uniqueName) || 0;
  const missing = Math.max(0, count - owned);

  const children: CraftingTreeNode[] = [];
  if (recipe && depth < MAX_DEPTH) {
    for (const ing of recipe.ingredients) {
      const ingItem = itemDb[ing.uniqueName];
      const ingRecipe = ingItem?.recipe || null;
      children.push(
        buildNode(ing.uniqueName, ing.count * count, ingRecipe, itemDb, ownership, depth + 1),
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
    isCraftable: recipe !== null,
    recipe,
    children,
  };
}

/** Compute a summary of all leaf resources needed. */
export function computeCraftingSummary(
  tree: CraftingTreeNode,
): CraftingTreeSummary {
  let totalCredits = 0;
  let totalBuildTime = 0;
  const resourceMap = new Map<string, { name: string; count: number; owned: number }>();

  function walk(node: CraftingTreeNode): void {
    if (node.recipe) {
      totalCredits += node.recipe.buildPrice;
      totalBuildTime = Math.max(totalBuildTime, node.recipe.buildTime);
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
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(tree);
  return {
    totalCredits,
    totalBuildTime,
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

/** Format seconds into a human-readable duration string. */
export function formatBuildTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
