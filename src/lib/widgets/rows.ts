import type { FoundryData } from "../../types/inventory.js";
import { isFoundryBuildClaimable, isFoundryRecipeReady } from "../inventory/foundryResources.js";

interface FoundryReadyRow {
  key: string;
  name: string;
  claimable: boolean;
}

/** Keys for a keyed each over rows that legitimately repeat, such as two Forma
    built side by side. A repeat gets a numbered suffix instead of throwing
    each_key_duplicate. */
export function withRowKeys<T extends object>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): (T & { rowKey: string })[] {
  const used = new Set<string>();
  return rows.map((row) => {
    const base = keyOf(row);
    let rowKey = base;
    for (let copy = 2; used.has(rowKey); copy += 1) rowKey = `${base}#${String(copy)}`;
    used.add(rowKey);
    return { ...row, rowKey };
  });
}

/** Finished builds first, then blueprints whose parts are all owned. */
export function foundryReadyRows(
  foundry: FoundryData,
  owned: ReadonlyMap<string, number>,
  chainBuildable: ReadonlySet<string>,
  nowMs: number,
): (FoundryReadyRow & { rowKey: string })[] {
  const claimable = foundry.building
    .filter((entry) => isFoundryBuildClaimable(entry, nowMs))
    .map((entry) => ({
      key: `building:${entry.productUniqueName ?? entry.name}`,
      name: entry.displayName || entry.name,
      claimable: true,
    }));
  const buildable = foundry.recipes
    .filter((recipe) => isFoundryRecipeReady(recipe, owned, chainBuildable))
    .map((recipe) => ({
      key: `recipe:${recipe.uniqueName ?? recipe.name}`,
      name: recipe.displayName || recipe.name,
      claimable: false,
    }));
  return withRowKeys([...claimable, ...buildable], (row) => row.key);
}
