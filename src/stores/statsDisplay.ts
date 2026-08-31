import { writable, type Writable } from "svelte/store";

import { readStorage, writeStorage } from "../lib/persistence.js";
import type { MessageKey } from "../lib/i18n.js";
import { DEFAULT_STAT_RESOURCE_IDS, STAT_RESOURCES } from "../../config/shared/statsTypes.js";

const STORAGE_KEY = "wf_stats_chart_resources";
const KNOWN_IDS = new Set(STAT_RESOURCES.map((r) => r.id));

// The six resources that predate the picker keep the keys they already had.
const REUSED_LABEL_KEYS: Record<string, MessageKey> = {
  plat: "common.platinum",
  ducats: "common.ducats",
  aya: "stats.aya",
  credits: "common.credits",
  endo: "stats.endo",
  vitus: "stats.vitus",
};

// Every other resource follows stats.resource.<id>. The cast is needed because
// the key union comes from en.json, which the shared catalog cannot import.
export function statResourceLabelKey(id: string): MessageKey {
  return REUSED_LABEL_KEYS[id] ?? (`stats.resource.${id}` as MessageKey);
}

/**
 * Keeps catalog order and drops ids this build no longer records, so a pref
 * written by a newer build (or hand-edited) cannot break the chart grid.
 */
function normalize(ids: readonly string[]): string[] {
  const wanted = new Set(ids.filter((id) => KNOWN_IDS.has(id)));
  return STAT_RESOURCES.filter((r) => wanted.has(r.id)).map((r) => r.id);
}

function load(): string[] {
  const raw = readStorage(STORAGE_KEY);
  // No stored pref is different from an empty one: the user may have switched
  // every chart off, and that choice has to survive a reload.
  if (raw === null) return normalize(DEFAULT_STAT_RESOURCE_IDS);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return normalize(DEFAULT_STAT_RESOURCE_IDS);
    return normalize(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return normalize(DEFAULT_STAT_RESOURCE_IDS);
  }
}

const store = writable<string[]>(load());

function save(ids: string[]): string[] {
  const next = normalize(ids);
  writeStorage(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Resource ids the Stats tab charts, in catalog order. Recording ignores this. */
export const chartResources: Writable<string[]> = {
  subscribe: store.subscribe,
  set(value: string[]): void {
    store.set(save(value));
  },
  update(fn: (value: string[]) => string[]): void {
    store.update((current) => save(fn(current)));
  },
};

export function toggleChartResource(id: string): void {
  chartResources.update((current) =>
    current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
  );
}

export function resetChartResources(): void {
  chartResources.set([...DEFAULT_STAT_RESOURCE_IDS]);
}
