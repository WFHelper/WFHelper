import { get, writable, type Readable, type Writable } from "svelte/store";

import { readStorage, writeStorage } from "../lib/persistence.js";

/** A named set of inventory selection keys the user can re-apply later. */
export interface SavedSelection {
  name: string;
  keys: string[];
}

const SAVED_KEY = "wf_inventory_saved_selections";
const MAX_SAVED = 25;

function isSavedSelection(entry: unknown): entry is SavedSelection {
  if (typeof entry !== "object" || entry == null) return false;
  const candidate = entry as Partial<SavedSelection>;
  return typeof candidate.name === "string" && Array.isArray(candidate.keys);
}

function loadSaved(): SavedSelection[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(SAVED_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isSavedSelection)
      .map((entry) => ({
        name: entry.name,
        keys: entry.keys.filter((key): key is string => typeof key === "string"),
      }))
      .filter((entry) => entry.name.length > 0)
      .slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

const modeStore = writable(false);
const selectedStore = writable<ReadonlySet<string>>(new Set());
const savedStore = writable<readonly SavedSelection[]>(loadSaved());

/** True while the inventory grid/list is picking items instead of opening them. */
export const inventorySelectionMode: Readable<boolean> = { subscribe: modeStore.subscribe };

/** Selected inventory keys. Read-only so every write replaces the Set and
 *  membership stays an O(1) `has` for the thousands of rows that ask. */
export const inventorySelection: Readable<ReadonlySet<string>> = {
  subscribe: selectedStore.subscribe,
};

export const savedSelections: Readable<readonly SavedSelection[]> = {
  subscribe: savedStore.subscribe,
};

/** Bulk Sell modal visibility; the modal itself is hosted by App.svelte. */
export const bulkSellOpen: Writable<boolean> = writable(false);

/** Leaving the mode keeps the picks: re-entering restores them, and only Clear
 *  or applying a saved selection replaces what is selected. */
export function setSelectionMode(active: boolean): void {
  modeStore.set(active);
}

export function toggleSelectionMode(): void {
  setSelectionMode(!get(modeStore));
}

export function toggleSelected(key: string): void {
  if (!key) return;
  selectedStore.update((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
}

/** `replace` powers "Select all" and loading a saved set; `add` powers shift-range. */
export function selectKeys(keys: Iterable<string>, mode: "replace" | "add" = "replace"): void {
  selectedStore.update((current) => {
    const next = mode === "add" ? new Set(current) : new Set<string>();
    for (const key of keys) {
      if (key) next.add(key);
    }
    return next;
  });
}

export function clearSelection(): void {
  selectedStore.set(new Set());
}

function persistSaved(next: SavedSelection[]): void {
  savedStore.set(next);
  writeStorage(SAVED_KEY, JSON.stringify(next));
}

/** Saving under an existing name overwrites it, so re-saving is one click. */
export function saveSelection(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const entry: SavedSelection = { name: trimmed, keys: [...get(selectedStore)] };
  const rest = get(savedStore).filter((saved) => saved.name !== trimmed);
  persistSaved([entry, ...rest].slice(0, MAX_SAVED));
}

export function loadSavedSelection(name: string): void {
  const entry = get(savedStore).find((saved) => saved.name === name);
  if (!entry) return;
  selectKeys(entry.keys, "replace");
}

export function deleteSavedSelection(name: string): void {
  persistSaved(get(savedStore).filter((saved) => saved.name !== name));
}
