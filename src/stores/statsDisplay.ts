import { writable, type Writable } from "svelte/store";

import { readStoredJson, writeStorage } from "../lib/persistence.js";
import type { MessageKey } from "../lib/i18n.js";
import { DEFAULT_STAT_RESOURCE_IDS, STAT_RESOURCES } from "../../config/shared/statsTypes.js";
import type { StatResourceId } from "../../config/shared/statsTypes.js";

const STORAGE_KEY = "wf_stats_chart_resources";
const KNOWN_IDS = new Set(STAT_RESOURCES.map((r) => r.id));

// The six resources that predate the picker keep the keys they already had; the rest
// follow stats.resource.<id>. Spelled out because the i18n scan reads literals only.
const RESOURCE_LABEL_KEYS: Record<StatResourceId, MessageKey> = {
  plat: "common.platinum",
  ducats: "common.ducats",
  aya: "stats.aya",
  credits: "common.credits",
  endo: "stats.endo",
  vitus: "stats.vitus",
  kuva: "stats.resource.kuva",
  regalAya: "stats.resource.regalAya",
  voidTraces: "stats.resource.voidTraces",
  steelEssence: "stats.resource.steelEssence",
  rivenSliver: "stats.resource.rivenSliver",
  vosfor: "stats.resource.vosfor",
  nitain: "stats.resource.nitain",
  forma: "stats.resource.forma",
  argonCrystal: "stats.resource.argonCrystal",
  orokinCell: "stats.resource.orokinCell",
  tellurium: "stats.resource.tellurium",
  somaticFibers: "stats.resource.somaticFibers",
  hexenon: "stats.resource.hexenon",
  narmerIsoplast: "stats.resource.narmerIsoplast",
  cetusWisp: "stats.resource.cetusWisp",
  pathosClamp: "stats.resource.pathosClamp",
};

export function statResourceLabelKey(id: string): MessageKey {
  return RESOURCE_LABEL_KEYS[id as StatResourceId] ?? "common.unknown";
}

/**
 * Keeps catalog order and drops ids this build no longer records, so a pref
 * written by a newer build (or hand-edited) cannot break the chart grid.
 */
function normalize(ids: readonly string[]): string[] {
  const wanted = new Set(ids.filter((id) => KNOWN_IDS.has(id)));
  return STAT_RESOURCES.filter((r) => wanted.has(r.id)).map((r) => r.id);
}

// No stored pref is different from an empty one: the user may have switched
// every chart off, and that choice has to survive a reload.
function load(): string[] {
  return readStoredJson(
    STORAGE_KEY,
    (parsed) =>
      Array.isArray(parsed)
        ? normalize(parsed.filter((v): v is string => typeof v === "string"))
        : normalize(DEFAULT_STAT_RESOURCE_IDS),
    () => normalize(DEFAULT_STAT_RESOURCE_IDS),
  );
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
