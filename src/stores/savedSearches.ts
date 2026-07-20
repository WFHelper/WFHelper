import type { Writable } from "svelte/store";
import { persistedStringList } from "../lib/persistence.js";

const stores = new Map<string, Writable<string[]>>();

export function savedSearches(scope: string): Writable<string[]> {
  let store = stores.get(scope);
  if (!store) {
    store = persistedStringList(`savedSearches.${scope}`);
    stores.set(scope, store);
  }
  return store;
}

export function addSavedSearch(scope: string, text: string): void {
  const query = text.trim();
  if (!query) return;
  savedSearches(scope).update((list) =>
    list.some((s) => s.toLowerCase() === query.toLowerCase()) ? list : [...list, query],
  );
}

export function removeSavedSearch(scope: string, text: string): void {
  savedSearches(scope).update((list) => list.filter((s) => s !== text));
}
