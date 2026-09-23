import type { ItemDbEntry, RawInventoryData } from "../types/inventory.js";
import {
  CIRCUIT_HARD_ROTATION,
  circuitNameKey,
  circuitRotationIndex,
  incarnonFamilyKey,
  itemDbIndex,
  ownedSetsFor,
} from "./world.js";

export const INCARNON_MAX_EVOLUTION = 5;

type IncarnonKind = "genesis" | "native";
type IncarnonStatus = "unlocked" | "adapter" | "missing";
type IncarnonSlot = "primary" | "secondary" | "melee";
export type IncarnonFilter = "all" | IncarnonStatus;

export const INCARNON_FILTERS: readonly IncarnonFilter[] = [
  "all",
  "unlocked",
  "adapter",
  "missing",
];

export interface IncarnonWeapon {
  kind: IncarnonKind;
  /** English base-weapon name, the join key for the Circuit strip. */
  name: string;
  displayName?: string;
  /** Base weapon, or the adapter when the item DB has no picture of the weapon. */
  uniqueName: string;
  imageUrl: string;
  slot?: IncarnonSlot;
  adapterUniqueName?: string;
  /** Any weapon of the family (Prime, Vandal, MK1 and the like) is in the arsenal. */
  weaponOwned: boolean;
  /** Native weapons only: its blueprint waits in Recipes while the weapon is not owned. */
  blueprintOwned?: true;
  /** Spare Genesis adapters in MiscItems. */
  adapterCount: number;
  /** Genesis: the adapter sits on a family weapon. Native: the weapon is owned. */
  unlocked: boolean;
  /** Highest unlocked evolution, 1 to 5, absent without an EvolutionProgress entry. */
  evolution?: number;
  /** Weeks until the Steel Path Circuit offers the adapter again, 0 = this week. */
  circuitWeeks?: number;
  status: IncarnonStatus;
}

interface IncarnonSummary {
  total: number;
  unlocked: number;
  adapter: number;
  missing: number;
}

const GENESIS_SUFFIX = " Incarnon Genesis";
const SLOT_ORDER: Record<IncarnonSlot, number> = { primary: 0, secondary: 1, melee: 2 };
const ADAPTER_SLOT_RE = /\/IncarnonAdapters\/(Primary|Secondary|Melee)\//;
const ADAPTER_SLOTS: Record<string, IncarnonSlot> = {
  Primary: "primary",
  Secondary: "secondary",
  Melee: "melee",
};

function slotOfEntry(entry: ItemDbEntry | undefined): IncarnonSlot | undefined {
  const product = (entry?.productCategory || "").toLowerCase();
  const category = (entry?.category || "").toLowerCase();
  if (product === "longguns" || category === "primary") return "primary";
  if (product === "pistols" || category === "secondary") return "secondary";
  if (product === "melee" || category === "melee") return "melee";
  return undefined;
}

function slotOfAdapter(uniqueName: string): IncarnonSlot | undefined {
  const match = ADAPTER_SLOT_RE.exec(uniqueName);
  return match ? ADAPTER_SLOTS[match[1]] : undefined;
}

interface EvolutionRow {
  itemType: string;
  tier: number;
}

// Rank is 0-based: all six Genesis entries on a live account sat at Rank 4 with
// Progress 0, so Rank 4 is the fifth and last evolution.
function evolutionByFamily(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): Map<string, EvolutionRow> {
  const out = new Map<string, EvolutionRow>();
  const rows = inventoryData?.EvolutionProgress;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { ItemType, Rank } = row as { ItemType?: unknown; Rank?: unknown };
    if (typeof ItemType !== "string" || typeof Rank !== "number" || !Number.isFinite(Rank)) {
      continue;
    }
    const name = itemDb[ItemType]?.name;
    if (!name) continue;
    const tier = Math.min(INCARNON_MAX_EVOLUTION, Math.max(1, Math.floor(Rank) + 1));
    const key = incarnonFamilyKey(name);
    if (tier > (out.get(key)?.tier ?? 0)) out.set(key, { itemType: ItemType, tier });
  }
  return out;
}

function blueprintProducts(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): Set<string> {
  const out = new Set<string>();
  for (const row of inventoryData?.Recipes ?? []) {
    const product = row?.ItemType ? itemDb[row.ItemType]?.buildsProduct : undefined;
    if (typeof product === "string" && product) out.add(product);
  }
  return out;
}

/** Name key to weeks until the Steel Path Circuit offers that adapter. Live
 *  choices always read as this week, even when the rotation cannot be placed. */
export function circuitWeeksByKey(hardChoices: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const current = circuitRotationIndex(CIRCUIT_HARD_ROTATION, hardChoices);
  if (current >= 0) {
    const weeks = CIRCUIT_HARD_ROTATION.length;
    CIRCUIT_HARD_ROTATION.forEach((week, i) => {
      for (const name of week) out.set(circuitNameKey(name), (i - current + weeks) % weeks);
    });
  }
  for (const name of hardChoices) out.set(circuitNameKey(name), 0);
  return out;
}

interface GenesisSeed {
  fallbackName: string;
  adapter?: { uniqueName: string; imageUrl: string };
}

function genesisSeeds(itemDb: Record<string, ItemDbEntry>): Map<string, GenesisSeed> {
  const seeds = new Map<string, GenesisSeed>();
  for (const [key, adapter] of itemDbIndex(itemDb).incarnonAdapters) {
    seeds.set(key, {
      fallbackName: adapter.name.slice(0, -GENESIS_SUFFIX.length),
      adapter: { uniqueName: adapter.uniqueName, imageUrl: adapter.imageUrl },
    });
  }
  for (const week of CIRCUIT_HARD_ROTATION) {
    for (const name of week) {
      const key = circuitNameKey(name);
      if (!seeds.has(key)) seeds.set(key, { fallbackName: name });
    }
  }
  return seeds;
}

function compareWeapons(a: IncarnonWeapon, b: IncarnonWeapon): number {
  if (a.kind !== b.kind) return a.kind === "genesis" ? -1 : 1;
  const slotA = a.slot ? SLOT_ORDER[a.slot] : 3;
  const slotB = b.slot ? SLOT_ORDER[b.slot] : 3;
  if (slotA !== slotB) return slotA - slotB;
  return a.name.localeCompare(b.name);
}

/** Genesis weapons come from item DB adapters plus the Circuit rotation; native ones
 *  from the item DB flag or an EvolutionProgress entry outside the Genesis families. */
export function buildIncarnonWeapons(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
  hardChoices: string[] = [],
): IncarnonWeapon[] {
  if (!itemDb) return [];
  const index = itemDbIndex(itemDb);
  const sets = ownedSetsFor(itemDb, inventoryData);
  const evolution = evolutionByFamily(itemDb, inventoryData);
  const circuitWeeks = circuitWeeksByKey(hardChoices);
  const seeds = genesisSeeds(itemDb);
  const weapons: IncarnonWeapon[] = [];

  for (const [key, seed] of seeds) {
    const base = index.byCircuitName.get(key);
    const adapterCount = seed.adapter ? (sets.adapterCounts.get(seed.adapter.uniqueName) ?? 0) : 0;
    const unlocked = sets.installedIncarnonKeys.has(key);
    const tier = evolution.get(key)?.tier;
    const weeks = circuitWeeks.get(key);
    const displayName = base?.entry.displayName;
    weapons.push({
      kind: "genesis",
      name: base?.name ?? seed.fallbackName,
      ...(displayName ? { displayName } : {}),
      uniqueName: base?.uniqueName ?? seed.adapter?.uniqueName ?? "",
      imageUrl: seed.adapter?.imageUrl || base?.imageUrl || "",
      ...optionalSlot(
        (seed.adapter && slotOfAdapter(seed.adapter.uniqueName)) || slotOfEntry(base?.entry),
      ),
      ...(seed.adapter ? { adapterUniqueName: seed.adapter.uniqueName } : {}),
      weaponOwned: sets.ownedWeaponKeys.has(key),
      adapterCount,
      unlocked,
      ...(tier !== undefined ? { evolution: tier } : {}),
      ...(weeks !== undefined ? { circuitWeeks: weeks } : {}),
      status: unlocked ? "unlocked" : adapterCount > 0 ? "adapter" : "missing",
    });
  }

  const natives = new Map<string, { uniqueName: string; entry: ItemDbEntry }>();
  for (const hit of index.nativeIncarnons) {
    const key = incarnonFamilyKey(hit.name);
    if (!seeds.has(key) && !natives.has(key)) {
      natives.set(key, { uniqueName: hit.uniqueName, entry: hit.entry });
    }
  }
  for (const [key, row] of evolution) {
    const entry = itemDb[row.itemType];
    if (seeds.has(key) || natives.has(key) || !slotOfEntry(entry)) continue;
    natives.set(key, { uniqueName: row.itemType, entry });
  }

  const blueprints =
    natives.size > 0 ? blueprintProducts(itemDb, inventoryData) : new Set<string>();
  for (const [key, { uniqueName, entry }] of natives) {
    const owned = sets.ownedWeaponKeys.has(key);
    const tier = evolution.get(key)?.tier;
    weapons.push({
      kind: "native",
      name: entry.name || uniqueName,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      uniqueName,
      imageUrl: entry.imageUrl || "",
      ...optionalSlot(slotOfEntry(entry)),
      weaponOwned: owned,
      ...(!owned && blueprints.has(uniqueName) ? { blueprintOwned: true as const } : {}),
      adapterCount: 0,
      unlocked: owned,
      ...(tier !== undefined ? { evolution: tier } : {}),
      status: owned ? "unlocked" : "missing",
    });
  }

  return weapons.sort(compareWeapons);
}

function optionalSlot(slot: IncarnonSlot | undefined): { slot?: IncarnonSlot } {
  return slot ? { slot } : {};
}

/** Lookup for the Circuit strip, keyed like its choice names. */
export function incarnonByName(weapons: readonly IncarnonWeapon[]): Map<string, IncarnonWeapon> {
  const out = new Map<string, IncarnonWeapon>();
  for (const weapon of weapons) {
    const key = circuitNameKey(weapon.name);
    if (!out.has(key)) out.set(key, weapon);
  }
  return out;
}

export function incarnonFor(
  lookup: ReadonlyMap<string, IncarnonWeapon>,
  name: string,
): IncarnonWeapon | null {
  return lookup.get(circuitNameKey(name)) ?? null;
}

export function summarizeIncarnon(weapons: readonly IncarnonWeapon[]): IncarnonSummary {
  const summary: IncarnonSummary = { total: weapons.length, unlocked: 0, adapter: 0, missing: 0 };
  for (const weapon of weapons) summary[weapon.status] += 1;
  return summary;
}

export function filterIncarnon(
  weapons: readonly IncarnonWeapon[],
  filter: IncarnonFilter,
): IncarnonWeapon[] {
  return filter === "all" ? [...weapons] : weapons.filter((weapon) => weapon.status === filter);
}
