import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../config/shared/componentNames.js";
import { resolveComponentByName } from "./componentResolution.js";
import { buildCraftingTree, type CraftingTreeNode } from "./craftingTree.js";
import type { ComponentInfo, ItemDbEntry } from "../types/inventory.js";

export interface PlannerPin {
  uniqueName: string;
  name: string;
  displayName?: string;
  imageUrl: string | null;
  masteryXpRemaining: number;
}

interface PlannerComponent {
  uniqueName: string;
  name: string;
  displayName?: string;
  imageUrl: string | null;
  needed: number;
  owned: number;
  missing: number;
  craftable: boolean;
  isBlueprint: boolean;
}

interface PlannerResource {
  uniqueName: string;
  name: string;
  displayName?: string;
  needed: number;
  owned: number;
  missing: number;
}

export interface PlannedItem {
  uniqueName: string;
  name: string;
  displayName?: string;
  imageUrl: string | null;
  masteryXpRemaining: number;
  /** False when the item DB has no recipe to walk; the row then has no plan. */
  hasRecipe: boolean;
  components: PlannerComponent[];
  resources: PlannerResource[];
  credits: number;
  /** Share of the top-level requirements already covered, 0..1. */
  completeness: number;
  craftableNow: boolean;
}

export interface MasteryPlan {
  items: PlannedItem[];
  totals: PlannerResource[];
  totalCredits: number;
  craftableCount: number;
}

export type PlannerSort = "mastery_xp" | "completeness" | "name";

// Components and blueprints live under /Types/Recipes/; anything else a recipe
// asks for is a raw material the bill counts against the inventory pool.
const RECIPE_PATH = /\/Types\/Recipes\//i;

function isPartLike(node: CraftingTreeNode): boolean {
  return node.isCraftable || node.isBlueprintItem === true || RECIPE_PATH.test(node.uniqueName);
}

/** Aliases are one pile in two spellings, so a take lowers every spelling. */
function consumeOwned(budget: Map<string, number>, uniqueName: string, units: number): void {
  if (units <= 0) return;
  for (const alias of componentUniqueNameAliases(uniqueName)) {
    const have = budget.get(alias);
    if (have === undefined) continue;
    budget.set(alias, Math.max(0, have - units));
  }
}

interface ResourceTally {
  name: string;
  displayName?: string;
  needed: number;
}

interface CollectState {
  resources: Map<string, ResourceTally>;
  credits: number;
}

function addResource(state: CollectState, node: CraftingTreeNode, needed: number): void {
  const existing = state.resources.get(node.uniqueName);
  if (existing) {
    existing.needed += needed;
    return;
  }
  state.resources.set(node.uniqueName, {
    name: node.name,
    ...(node.displayName ? { displayName: node.displayName } : {}),
    needed,
  });
}

function collectNode(
  node: CraftingTreeNode,
  needed: number,
  depth: number,
  state: CollectState,
  budget: Map<string, number>,
): void {
  if (needed <= 0) return;

  let remaining = needed;
  if (depth > 0 && isPartLike(node)) {
    // Read live: one part can appear twice in a tree, and earlier pins already
    // spent their share of the same pile.
    const owned = Math.min(ownedComponentCount(node.uniqueName, budget), remaining);
    consumeOwned(budget, node.uniqueName, owned);
    remaining -= owned;
  }
  if (remaining <= 0) return;

  const recipe = node.recipe;
  if (!recipe || node.children.length === 0) {
    if (depth === 0) return;
    // A farmed part of the pinned item is already a component chip on the row.
    if (depth === 1 && isPartLike(node)) return;
    // planPin measures the row against the shared pool, so it needs the gross
    // count; `remaining` already had the owned copies taken out of the budget.
    addResource(state, node, needed);
    return;
  }

  // A run yields `num` units, so runs - not units - drive costs and ingredients.
  const num = Math.max(1, recipe.num || 1);
  const fullRuns = Math.max(1, Math.ceil(node.count / num));
  const runs = Math.max(1, Math.ceil(remaining / num));
  state.credits += (recipe.buildPrice || 0) * runs;

  for (const child of node.children) {
    if (child.isBlueprintItem) {
      collectNode(child, recipe.reusableBlueprint ? 1 : runs, depth + 1, state, budget);
      continue;
    }
    // Children were sized for fullRuns, so child.count is a multiple of it.
    collectNode(child, Math.ceil((child.count * runs) / fullRuns), depth + 1, state, budget);
  }
}

function planPin(
  pin: PlannerPin,
  itemDb: Record<string, ItemDbEntry>,
  budget: Map<string, number>,
  pool: Map<string, number>,
): PlannedItem {
  const base = {
    uniqueName: pin.uniqueName,
    name: pin.name,
    ...(pin.displayName ? { displayName: pin.displayName } : {}),
    imageUrl: pin.imageUrl,
    masteryXpRemaining: pin.masteryXpRemaining,
  };

  const tree = buildCraftingTree(pin.uniqueName, itemDb, budget);
  if (!tree) {
    return {
      ...base,
      hasRecipe: false,
      components: [],
      resources: [],
      credits: 0,
      completeness: 0,
      craftableNow: false,
    };
  }

  // Every top-level child counts toward readiness, but only parts get a chip:
  // a raw material the root recipe asks for already has its own material row.
  const topLevel = tree.children;
  const components: PlannerComponent[] = topLevel.filter(isPartLike).map((child) => ({
    uniqueName: child.uniqueName,
    name: child.name,
    ...(child.displayName ? { displayName: child.displayName } : {}),
    imageUrl: child.imageUrl,
    needed: child.count,
    owned: child.owned,
    missing: child.missing,
    craftable: child.isCraftable,
    isBlueprint: child.isBlueprintItem === true,
  }));

  const state: CollectState = { resources: new Map(), credits: 0 };
  collectNode(tree, 1, 0, state, budget);

  const resources: PlannerResource[] = [...state.resources.entries()].map(([uniqueName, tally]) => {
    // Take this pin's share of the pile so the rows below a shared material add
    // up to the total row instead of each claiming the whole pool.
    const owned = Math.min(ownedComponentCount(uniqueName, pool), tally.needed);
    consumeOwned(pool, uniqueName, owned);
    return {
      uniqueName,
      name: tally.name,
      ...(tally.displayName ? { displayName: tally.displayName } : {}),
      needed: tally.needed,
      owned,
      missing: Math.max(0, tally.needed - owned),
    };
  });
  resources.sort(
    (a, b) => b.missing - a.missing || b.needed - a.needed || a.name.localeCompare(b.name),
  );

  const satisfied = topLevel.filter((child) => child.missing === 0).length;
  const completeness = topLevel.length > 0 ? satisfied / topLevel.length : 1;

  return {
    ...base,
    hasRecipe: true,
    components,
    resources,
    credits: state.credits,
    completeness,
    craftableNow: satisfied === topLevel.length,
  };
}

// One plan per pin. Owned parts AND raw materials are allocated to pins in
// order, so a single spare cannot satisfy two of them. The total row still
// measures the summed need once against the untouched inventory pool.
export function buildMasteryPlan(
  pins: readonly PlannerPin[],
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): MasteryPlan {
  const budget = new Map(ownership);
  const materials = new Map(ownership);
  const totals = new Map<string, PlannerResource>();
  const items: PlannedItem[] = [];
  let totalCredits = 0;
  let craftableCount = 0;

  for (const pin of pins) {
    const planned = planPin(pin, itemDb, budget, materials);
    items.push(planned);
    totalCredits += planned.credits;
    if (planned.craftableNow && planned.hasRecipe) craftableCount += 1;
    for (const resource of planned.resources) {
      const existing = totals.get(resource.uniqueName);
      if (existing) existing.needed += resource.needed;
      else {
        totals.set(resource.uniqueName, {
          ...resource,
          owned: ownedComponentCount(resource.uniqueName, ownership),
        });
      }
    }
  }

  const totalRows = [...totals.values()].map((row) => ({
    ...row,
    missing: Math.max(0, row.needed - row.owned),
  }));
  totalRows.sort(
    (a, b) => b.missing - a.missing || b.needed - a.needed || a.name.localeCompare(b.name),
  );

  return { items, totals: totalRows, totalCredits, craftableCount };
}

interface PlannerRow {
  uniqueName: string;
  name: string;
  displayName?: string;
  needed: number;
  owned: number;
  missing: number;
}

// Planner rows carry the item database's parent-prefixed name ("Braton Prime
// Receiver"), while the detail modal prices a part as `${parentName} ${name}`.
// Resolving the row back to its parent's short part name keeps that join from
// doubling the parent, and leaves a raw material with no parent at all.
export function plannerModalTarget(
  row: PlannerRow,
  itemDb: Record<string, ItemDbEntry>,
  nameIndex?: Map<string, string>,
): { comp: ComponentInfo; parentName: string } {
  const resolved = resolveComponentByName(row.name, itemDb, new Map(), nameIndex);
  const base: ComponentInfo = resolved?.comp ?? {
    name: row.name,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    uniqueName: row.uniqueName,
  };
  return {
    comp: { ...base, itemCount: row.needed, ownedCount: row.owned, owned: row.missing === 0 },
    parentName: resolved?.parentName ?? "",
  };
}

/** The planner is a to-do list, so covered rows stay hidden until asked for. */
export function missingOnly<T extends { missing: number }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.missing > 0);
}

/** Craftable-now floats to the top of every sort mode. */
export function sortPlannedItems(
  items: readonly PlannedItem[],
  sort: PlannerSort,
  label: (item: PlannedItem) => string,
): PlannedItem[] {
  const group = (item: PlannedItem): number => (item.craftableNow && item.hasRecipe ? 0 : 1);
  const within = (a: PlannedItem, b: PlannedItem): number => {
    if (sort === "mastery_xp") return b.masteryXpRemaining - a.masteryXpRemaining;
    if (sort === "completeness") return b.completeness - a.completeness;
    return 0;
  };
  return [...items].sort(
    (a, b) => group(a) - group(b) || within(a, b) || label(a).localeCompare(label(b)),
  );
}

/** Same order as the flat sort, split so each half can carry its own heading. */
export function groupPlannedItems(
  items: readonly PlannedItem[],
  sort: PlannerSort,
  label: (item: PlannedItem) => string,
): { craftable: PlannedItem[]; remaining: PlannedItem[] } {
  const sorted = sortPlannedItems(items, sort, label);
  const ready = (item: PlannedItem): boolean => item.craftableNow && item.hasRecipe;
  return {
    craftable: sorted.filter((item) => ready(item)),
    remaining: sorted.filter((item) => !ready(item)),
  };
}
