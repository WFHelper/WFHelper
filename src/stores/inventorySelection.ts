import { get, writable, type Readable, type Writable } from "svelte/store";

import { selectionOwnership } from "../lib/inventory/selectionAlerts.js";
import { readStorage, writeStorage } from "../lib/persistence.js";
import { parsedItems } from "./data.js";

/** A named set of inventory selection keys the user can re-apply later. */
export interface SavedSelection {
  name: string;
  keys: string[];
  /** Notify once when every key in the set becomes owned. */
  alertWhenComplete?: boolean;
  /** Completeness at the last evaluation; the edge the alert fires on. */
  lastComplete?: boolean;
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
        // Both flags are optional and only ever true, so a file written by an
        // older build revives as "alert off, never evaluated".
        ...(entry.alertWhenComplete === true ? { alertWhenComplete: true } : {}),
        ...(entry.lastComplete === true ? { lastComplete: true } : {}),
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

// An unloaded inventory reads as incomplete rather than as "nothing owned", so
// enabling the alert before the first load still fires once the items arrive.
function completeNow(entry: SavedSelection): boolean {
  const items = get(parsedItems);
  return items.length > 0 && selectionOwnership(entry, items).complete;
}

/** Saving under an existing name overwrites it, so re-saving is one click. The
 *  alert switch survives that, re-baselined against the new key set. */
export function saveSelection(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const previous = get(savedStore).find((saved) => saved.name === trimmed);
  const entry: SavedSelection = { name: trimmed, keys: [...get(selectedStore)] };
  if (previous?.alertWhenComplete === true) {
    entry.alertWhenComplete = true;
    if (completeNow(entry)) entry.lastComplete = true;
  }
  const rest = get(savedStore).filter((saved) => saved.name !== trimmed);
  persistSaved([entry, ...rest].slice(0, MAX_SAVED));
}

/** Turning the alert on records the current completeness, so a set that is
 *  already complete does not notify the moment the switch goes on. */
export function setSelectionAlert(name: string, on: boolean): void {
  const current = get(savedStore);
  const entry = current.find((saved) => saved.name === name);
  if (!entry) return;
  const next: SavedSelection = { name: entry.name, keys: entry.keys };
  if (on) {
    next.alertWhenComplete = true;
    if (completeNow(entry)) next.lastComplete = true;
  }
  persistSaved(current.map((saved) => (saved === entry ? next : saved)));
}

/** Both directions: a set that drops back to incomplete can fire again later. */
export function recordSelectionCompleteness(name: string, complete: boolean): void {
  const current = get(savedStore);
  const entry = current.find((saved) => saved.name === name);
  if (!entry) return;
  if ((entry.lastComplete === true) === complete) return;
  const next: SavedSelection = { ...entry };
  if (complete) next.lastComplete = true;
  else delete next.lastComplete;
  persistSaved(current.map((saved) => (saved === entry ? next : saved)));
}

export function loadSavedSelection(name: string): void {
  const entry = get(savedStore).find((saved) => saved.name === name);
  if (!entry) return;
  selectKeys(entry.keys, "replace");
}

export function deleteSavedSelection(name: string): void {
  persistSaved(get(savedStore).filter((saved) => saved.name !== name));
}
