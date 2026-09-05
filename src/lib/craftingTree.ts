import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../config/shared/componentNames.js";
import { fallbackNameFromUniqueName } from "../../config/shared/displayName.js";
import type { ItemDbEntry, RecipeData } from "../types/inventory.js";

export interface CraftingTreeNode {
  uniqueName: string;
  name: string;
  displayName?: string;
  imageUrl: string | null;
  count: number;
  owned: number;
  missing: number;
  isCraftable: boolean;
  /** True for blueprint-item child nodes (the "Hide blueprints" toggle filters these). */
  isBlueprintItem?: boolean;
  /** A filter removed children here, so the card must not offer to re-expand them. */
  childrenHidden?: boolean;
  recipe: RecipeData | null;
  usedFor: Array<{
    uniqueName: string;
    name: string;
    displayName?: string;
    imageUrl: string | null;
  }>;
  children: CraftingTreeNode[];
}

interface CraftingTreeTally {
  uniqueName: string;
  name: string;
  displayName?: string;
  count: number;
  owned: number;
}

interface CraftingTreeSummary {
  totalCredits: number;
  minBuildTime: number;
  maxBuildTime: number;
  blueprints: CraftingTreeTally[];
  resources: CraftingTreeTally[];
}

const MAX_DEPTH = 5;

/** Lazily expanded levels allowed below the eagerly built tree. */
export const MAX_EXPAND_DEPTH = 3;

/** Common resource path prefixes - never recurse into these sub-trees. */
const LEAF_RESOURCE_PREFIXES = ["/Lotus/Types/Items/MiscItems/", "/Lotus/Types/Items/Research/"];

interface BuildContext {
  itemDb: Record<string, ItemDbEntry>;
  ownership: Map<string, number>;
  maxDepth: number;
}

export function buildCraftingTree(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): CraftingTreeNode | null {
  const item = itemDb[uniqueName];
  if (!item?.recipe) return null;

  // The leaf rule stops recursion INTO a common resource; asking for its own
  // tree is explicit, so the root always shows its recipe.
  return buildNode(
    { itemDb, ownership, maxDepth: MAX_DEPTH },
    uniqueName,
    1,
    item.recipe,
    0,
    findUsedFor(uniqueName, itemDb),
    new Set([uniqueName]),
    true,
  );
}

function isLeafResource(uniqueName: string): boolean {
  return LEAF_RESOURCE_PREFIXES.some((p) => uniqueName.startsWith(p));
}

/** Two spellings of one inventory pile - the game never hands out both. */
function isSameOwnedItem(a: string, b: string): boolean {
  return a === b || componentUniqueNameAliases(a).includes(b);
}

function isAncestor(ancestors: Iterable<string>, uniqueName: string): boolean {
  for (const ancestor of ancestors) {
    if (isSameOwnedItem(ancestor, uniqueName)) return true;
  }
  return false;
}

const materialNameCache = new WeakMap<Record<string, ItemDbEntry>, Map<string, string[]>>();

/** All ingredient names in an item's crafting tree (direct + nested part recipes). */
export function collectRecipeMaterialNames(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): string[] {
  let cache = materialNameCache.get(itemDb);
  if (!cache) {
    cache = new Map();
    materialNameCache.set(itemDb, cache);
  }
  const hit = cache.get(uniqueName);
  if (hit) return hit;

  const out = new Set<string>();
  walkMaterialNames(uniqueName, itemDb, 0, new Set(), out);
  const list = [...out];
  cache.set(uniqueName, list);
  return list;
}

function walkMaterialNames(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  depth: number,
  visited: Set<string>,
  out: Set<string>,
): void {
  if (depth > 4 || visited.has(uniqueName)) return;
  visited.add(uniqueName);
  const recipe = itemDb[uniqueName]?.recipe;
  if (!recipe) return;
  for (const ing of recipe.ingredients) {
    const name = itemDb[ing.uniqueName]?.name;
    if (name) out.add(name);
    if (!isLeafResource(ing.uniqueName)) {
      walkMaterialNames(ing.uniqueName, itemDb, depth + 1, visited, out);
    }
  }
}

function buildNode(
  ctx: BuildContext,
  uniqueName: string,
  count: number,
  recipe: RecipeData | null,
  depth: number,
  usedFor: CraftingTreeNode["usedFor"] = [],
  ancestors: Set<string> = new Set(),
  ignoreLeafRule = false,
): CraftingTreeNode {
  const { itemDb, ownership } = ctx;
  const item = itemDb[uniqueName];
  const name = item?.name || fallbackNameFromUniqueName(uniqueName);
  const imageUrl = item?.imageUrl || null;
  const owned = ownedComponentCount(uniqueName, ownership);
  const missing = Math.max(0, count - owned);

  // Treat common resources as leaf nodes even if they have recipes. Expanding
  // one is an explicit user request, so that node alone opts out of the rule.
  const effectiveRecipe = !ignoreLeafRule && isLeafResource(uniqueName) ? null : recipe;

  // A run of the recipe can yield several units (num), so blueprints,
  // ingredients, credits and time all scale with runs, not units.
  const builds = effectiveRecipe
    ? Math.max(1, Math.ceil(count / Math.max(1, effectiveRecipe.num || 1)))
    : 0;

  const children: CraftingTreeNode[] = [];
  if (effectiveRecipe && depth < ctx.maxDepth) {
    // Blueprints are not listed as ingredients. Skip alternate component spellings
    // (the same owned pile twice) and one already on the path above, which builds
    // this very node and would hang it under itself.
    if (
      effectiveRecipe.blueprintUniqueName &&
      !isSameOwnedItem(uniqueName, effectiveRecipe.blueprintUniqueName) &&
      !isAncestor(ancestors, effectiveRecipe.blueprintUniqueName)
    ) {
      const bpUn = effectiveRecipe.blueprintUniqueName;
      const bpItem = itemDb[bpUn];
      const bpOwned = ownedComponentCount(bpUn, ownership);
      // Reusable (infinite-use) blueprints cover any build count with one copy.
      const bpNeeded = effectiveRecipe.reusableBlueprint ? 1 : builds;
      children.push({
        uniqueName: bpUn,
        name: bpItem?.name || `${name} Blueprint`,
        ...(bpItem?.displayName ? { displayName: bpItem.displayName } : {}),
        imageUrl: bpItem?.imageUrl || null,
        count: bpNeeded,
        owned: bpOwned,
        missing: Math.max(0, bpNeeded - bpOwned),
        isCraftable: false,
        isBlueprintItem: true,
        recipe: null,
        usedFor: [],
        children: [],
      });
    }

    for (const ing of aggregateIngredients(effectiveRecipe.ingredients)) {
      const ingItem = itemDb[ing.uniqueName];
      const ingRecipe = ingItem?.recipe || null;
      const nextCount = ing.count * builds;
      if (ancestors.has(ing.uniqueName)) {
        children.push(buildNode(ctx, ing.uniqueName, nextCount, null, depth + 1));
        continue;
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(ing.uniqueName);
      children.push(
        buildNode(ctx, ing.uniqueName, nextCount, ingRecipe, depth + 1, [], nextAncestors),
      );
    }
  }

  return {
    uniqueName,
    name,
    ...(item?.displayName ? { displayName: item.displayName } : {}),
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

interface ExpandableRecipe {
  productUniqueName: string;
  recipe: RecipeData;
}

// The recipe a node could expand into. A blueprint entry never carries a recipe
// of its own (parseFoundry maps blueprint -> product by scanning entry.recipe and
// would self-map), so it roots through buildsProduct like ItemDetailModal.
function resolveExpandableRecipe(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): ExpandableRecipe | null {
  const entry = itemDb[uniqueName];
  if (!entry) return null;
  if (entry.recipe) return { productUniqueName: uniqueName, recipe: entry.recipe };
  const productUniqueName = entry.buildsProduct;
  const product = productUniqueName ? itemDb[productUniqueName] : null;
  if (productUniqueName && product?.recipe) {
    return { productUniqueName, recipe: product.recipe };
  }
  return null;
}

// Whether a childless node has a sub-recipe worth a chevron. `ancestors` is the
// uniqueName path above the node, root first. A blueprint builds the item it hangs
// under, so matching it there is what keeps the expansion from looping.
export function canExpandCraftingNode(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ancestors: readonly string[],
): boolean {
  // Children a filter removed must stay removed, and an owned node has no bill left.
  if (node.children.length > 0 || node.childrenHidden) return false;
  if (missingUnits(node) <= 0) return false;
  const resolved = resolveExpandableRecipe(node.uniqueName, itemDb);
  if (!resolved) return false;
  return !ancestors.some(
    (ancestor) =>
      isSameOwnedItem(ancestor, node.uniqueName) ||
      isSameOwnedItem(ancestor, resolved.productUniqueName),
  );
}

/** What the node still costs: copies already owned are not built again. */
function missingUnits(node: CraftingTreeNode): number {
  return Math.max(0, node.count - node.owned);
}

/** The uniqueName path below a node the user expanded, root first. Expansion
 *  roots a blueprint through the product it builds, so that product belongs on
 *  the path too or the pair re-offers itself one level down. */
export function expandedChildAncestors(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ancestors: readonly string[],
): string[] {
  const product = resolveExpandableRecipe(node.uniqueName, itemDb)?.productUniqueName;
  const path = [...ancestors, node.uniqueName];
  if (product && product !== node.uniqueName) path.push(product);
  return path;
}

/** One level of children for a node the user chose to expand. */
export function expandCraftingNode(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  ancestors: readonly string[],
): CraftingTreeNode[] {
  if (!canExpandCraftingNode(node, itemDb, ancestors)) return [];
  const resolved = resolveExpandableRecipe(node.uniqueName, itemDb);
  if (!resolved) return [];

  const nextAncestors = new Set(expandedChildAncestors(node, itemDb, ancestors));
  // One level per click: every child re-earns its own chevron.
  return buildNode(
    { itemDb, ownership, maxDepth: 1 },
    resolved.productUniqueName,
    missingUnits(node),
    resolved.recipe,
    0,
    [],
    nextAncestors,
    true,
  ).children;
}

export interface CraftingTreeFilters {
  hideCompleted: boolean;
  hideBlueprints: boolean;
}

function withFilteredChildren(
  node: CraftingTreeNode,
  children: CraftingTreeNode[],
): CraftingTreeNode {
  const hidden = node.childrenHidden === true || children.length < node.children.length;
  return { ...node, children, ...(hidden ? { childrenHidden: true } : {}) };
}

function stripBlueprints(node: CraftingTreeNode): CraftingTreeNode {
  const children = node.children.filter((child) => !child.isBlueprintItem).map(stripBlueprints);
  return withFilteredChildren(node, children);
}

function filterCompleted(node: CraftingTreeNode, isRoot: boolean): CraftingTreeNode | null {
  if (node.owned >= node.count && node.children.length === 0) return null;
  const children = node.children
    .map((child) => filterCompleted(child, false))
    .filter((child): child is CraftingTreeNode => child !== null);
  // The root is the item the tree is about, so it stays even when covered.
  if (isRoot) return withFilteredChildren(node, children);
  if (node.owned >= node.count && children.length === 0) return null;
  return withFilteredChildren(node, children);
}

/** Toolbar filters for the eagerly built tree. */
export function applyCraftingTreeFilters(
  root: CraftingTreeNode,
  filters: CraftingTreeFilters,
): CraftingTreeNode | null {
  let result: CraftingTreeNode | null = filters.hideBlueprints ? stripBlueprints(root) : root;
  if (filters.hideCompleted && result) result = filterCompleted(result, true);
  return result;
}

/** The same predicates for a lazily expanded level the tree filter never saw. */
export function filterExpandedChildren(
  children: readonly CraftingTreeNode[],
  filters: CraftingTreeFilters,
): CraftingTreeNode[] {
  let out = [...children];
  if (filters.hideBlueprints) {
    out = out.filter((child) => !child.isBlueprintItem).map(stripBlueprints);
  }
  if (filters.hideCompleted) {
    out = out
      .map((child) => filterCompleted(child, false))
      .filter((child): child is CraftingTreeNode => child !== null);
  }
  return out;
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
      name: entry.name || fallbackNameFromUniqueName(productUniqueName),
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
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
  const blueprintMap = new Map<string, Omit<CraftingTreeTally, "uniqueName">>();
  const resourceMap = new Map<string, Omit<CraftingTreeTally, "uniqueName">>();

  function walk(node: CraftingTreeNode, depth: number): number {
    let subtreeTime = 0;
    if (node.recipe) {
      // Same yield rule as the tree: costs accrue per run, and one recipe
      // cannot run twice in parallel, so repeat runs stack sequentially.
      const runs = Math.max(1, Math.ceil(node.count / Math.max(1, node.recipe.num || 1)));
      totalCredits += node.recipe.buildPrice * runs;
      subtreeTime = node.recipe.buildTime * runs;
    }

    if (node.children.length === 0 && !node.isCraftable) {
      const existing = resourceMap.get(node.uniqueName);
      if (existing) {
        existing.count += node.count;
      } else {
        resourceMap.set(node.uniqueName, {
          name: node.name,
          ...(node.displayName ? { displayName: node.displayName } : {}),
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
            ...(node.displayName ? { displayName: node.displayName } : {}),
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
