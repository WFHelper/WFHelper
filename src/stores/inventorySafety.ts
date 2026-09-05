import { get, writable, type Readable } from "svelte/store";
import {
  DEFAULT_SAFETY_SETTINGS,
  normalizeSafetySettings,
  type InventorySafetySettings,
} from "../lib/inventory/safetyRules.js";
import { readStoredJson, writeStorage } from "../lib/persistence.js";

const STORAGE_KEY = "inventory.safety";

/** One blob rather than four keys: the rules are read together on every row,
 *  and a half-written pair of keys would reserve the wrong counts. */
function load(): InventorySafetySettings {
  return readStoredJson(STORAGE_KEY, normalizeSafetySettings, () => DEFAULT_SAFETY_SETTINGS);
}

const store = writable<InventorySafetySettings>(load());

function commit(next: InventorySafetySettings): void {
  const normalized = normalizeSafetySettings(next);
  writeStorage(STORAGE_KEY, JSON.stringify(normalized));
  store.set(normalized);
}

function edit(fn: (current: InventorySafetySettings) => InventorySafetySettings): void {
  commit(fn(get(store)));
}

/** Locks, spares and set-keep flags behind `safeToList`. Read-only: every write
 *  goes through the helpers below so the persisted blob stays normalized. */
export const inventorySafety: Readable<InventorySafetySettings> = { subscribe: store.subscribe };

export function setSpareDefault(count: number): void {
  edit((current) => ({ ...current, spareDefault: count }));
}

/** `null` drops the override so the row falls back to the global default. */
export function setItemSpare(key: string, count: number | null): void {
  if (!key) return;
  edit((current) => {
    const spares = { ...current.spares };
    if (count == null) delete spares[key];
    else spares[key] = count;
    return { ...current, spares };
  });
}

export function toggleSafetyLock(key: string): void {
  if (!key) return;
  edit((current) => ({
    ...current,
    locks: current.locks.includes(key)
      ? current.locks.filter((entry) => entry !== key)
      : [...current.locks, key],
  }));
}

/** Keyed by set ROOT uniqueName, so pass `setRootOf(item.internalName)`. */
export function toggleSetKeep(rootUniqueName: string): void {
  if (!rootUniqueName) return;
  edit((current) => ({
    ...current,
    setKeep: current.setKeep.includes(rootUniqueName)
      ? current.setKeep.filter((entry) => entry !== rootUniqueName)
      : [...current.setKeep, rootUniqueName],
  }));
}

export function resetInventorySafety(): void {
  commit(DEFAULT_SAFETY_SETTINGS);
}
