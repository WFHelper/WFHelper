import type { RecipeIngredient } from "../types/inventory.js";

interface PinnedResourceTotal {
  uniqueName: string;
  needed: number;
  owned: number;
}

interface PinnedTotals {
  count: number;
  credits: number;
  resources: PinnedResourceTotal[];
  missing: PinnedResourceTotal[];
}

interface PinnableEntry {
  source: string;
  uniqueName: string | null;
  ingredients: RecipeIngredient[];
  buildPrice: number;
}

/** Sum ingredient needs (one build each) across pinned blueprints. */
export function computePinnedTotals(
  entries: PinnableEntry[],
  pinned: ReadonlySet<string>,
  ownedOf: (uniqueName: string) => number,
): PinnedTotals {
  const needed = new Map<string, number>();
  const seen = new Set<string>();
  let credits = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.source !== "blueprint" || !entry.uniqueName) continue;
    if (!pinned.has(entry.uniqueName) || seen.has(entry.uniqueName)) continue;
    seen.add(entry.uniqueName);
    count += 1;
    credits += entry.buildPrice || 0;
    for (const ing of entry.ingredients) {
      needed.set(ing.uniqueName, (needed.get(ing.uniqueName) ?? 0) + ing.count);
    }
  }
  const resources = [...needed.entries()]
    .map(([uniqueName, total]) => ({ uniqueName, needed: total, owned: ownedOf(uniqueName) }))
    .sort((a, b) => b.needed - a.needed);
  return { count, credits, resources, missing: resources.filter((r) => r.owned < r.needed) };
}
