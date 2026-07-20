import { persistedStringList } from "../lib/persistence.js";

/** Blueprint uniqueNames pinned in the Foundry for the combined-resources summary. */
export const pinnedRecipes = persistedStringList("foundry.pinnedRecipes", 60);

export function togglePinnedRecipe(uniqueName: string): void {
  pinnedRecipes.update((list) =>
    list.includes(uniqueName) ? list.filter((u) => u !== uniqueName) : [...list, uniqueName],
  );
}

export function clearPinnedRecipes(): void {
  pinnedRecipes.set([]);
}
