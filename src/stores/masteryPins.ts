import { derived, type Readable, type Writable } from "svelte/store";

import { persistedStringList } from "../lib/persistence.js";

// Each pin costs one crafting-tree walk per inventory generation, so the list
// stays short rather than unbounded.
const MAX_MASTERY_PINS = 40;

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

// A hand-edited or corrupt list can repeat a uniqueName, which throws
// each_key_duplicate in the planner's keyed block. Dedupe on read so a plain
// start never writes localStorage, and again on every write.
const pins = persistedStringList("mastery.pinnedItems", MAX_MASTERY_PINS);
const dedupedPins = derived(pins, unique);

/** Mastery uniqueNames pinned for the Planned sub-tab, oldest first. */
export const masteryPins: Writable<string[]> = {
  subscribe: dedupedPins.subscribe,
  set(value: string[]): void {
    pins.set(unique(value));
  },
  update(fn: (value: string[]) => string[]): void {
    pins.update((current) => unique(fn(unique(current))));
  },
};

// Pins to keep even once the account masters them. Persisted because the view
// unmounts on every tab switch, which would let an undone auto-unpin re-fire.
const keepMastered = persistedStringList("mastery.pinnedKeepMastered", MAX_MASTERY_PINS);

export const masteryPinKeepMastered: Readable<string[]> = derived(keepMastered, unique);

export function toggleMasteryPin(uniqueName: string, keepWhenMastered = false): void {
  if (!uniqueName) return;
  let wasPinned = false;
  masteryPins.update((list) => {
    wasPinned = list.includes(uniqueName);
    return wasPinned ? list.filter((entry) => entry !== uniqueName) : [...list, uniqueName];
  });
  // An exemption only means anything while the pin exists, so unpinning prunes it.
  if (wasPinned) keepMastered.update((list) => list.filter((entry) => entry !== uniqueName));
  else if (keepWhenMastered) keepMastered.update((list) => unique([...list, uniqueName]));
}

/** One write for several drops, so an auto-unpin undo restores a single snapshot. */
export function unpinMasteryItems(uniqueNames: readonly string[]): void {
  if (uniqueNames.length === 0) return;
  const drop = new Set(uniqueNames);
  masteryPins.update((list) => list.filter((entry) => !drop.has(entry)));
  keepMastered.update((list) => list.filter((entry) => !drop.has(entry)));
}

/** Room left before the cap, so a restore trims itself instead of evicting. */
function fitting(list: readonly string[], incoming: readonly string[]): string[] {
  const room = Math.max(0, MAX_MASTERY_PINS - list.length);
  return incoming.filter((entry) => !list.includes(entry)).slice(0, room);
}

/** Undo of one auto-unpin event: re-pin those items and keep them through mastery.
 *  The cap rule is "keep the newest, additions append"; an undo is not a new
 *  addition, so at the cap the restore is trimmed rather than older pins. */
export function restoreMasteryPins(uniqueNames: readonly string[]): void {
  if (uniqueNames.length === 0) return;
  masteryPins.update((list) => [...list, ...fitting(list, uniqueNames)]);
  keepMastered.update((list) => {
    const current = unique(list);
    return [...current, ...fitting(current, uniqueNames)];
  });
}
