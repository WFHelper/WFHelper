import type { ItemDbEntry, RawInventoryData } from "../types/inventory.js";
import type { VaultTrader, VaultTraderInventoryItem, WorldState } from "../types/world.js";
import { PLANET_ICON_URLS } from "./assetUrls.js";
import {
  buildSubsumedFamilySet,
  consumedSuitUniqueNames,
  isFrameSubsumed,
  isSubsumableFrame,
} from "./helminth.js";
import { RELIC_ICON_PATHS, fissureTierClass } from "./relic/relicConstants.js";

export { RELIC_ICON_PATHS, fissureTierClass };

export const PLANET_ICON_PATHS: Record<string, string> = PLANET_ICON_URLS;

function isLikelyPrimeGear(name: string = ""): boolean {
  return (
    /prime/i.test(name) &&
    !/(scarf|armor|syandana|ephemera|sigil|glyph|emote|sugatra|operator|mask|noggle|pack)/i.test(
      name,
    )
  );
}

const PRIME_CATS = new Set([
  "warframe",
  "weapon",
  "companion",
  "warframes",
  "primary",
  "secondary",
  "melee",
  "sentinels",
  "pets",
  "sentinel weapons",
]);
const PRIME_PRODUCTS = new Set([
  "suits",
  "longguns",
  "pistols",
  "melee",
  "sentinels",
  "sentinelweapons",
]);

function isResurgenceCandidate(entry: ItemDbEntry = {}): boolean {
  if (!isLikelyPrimeGear(entry.name || "")) return false;
  const category = (entry.category || "").toLowerCase();
  const product = (entry.productCategory || "").toLowerCase();
  const type = (entry.type || "").toLowerCase();
  if (PRIME_CATS.has(category)) return true;
  if (PRIME_PRODUCTS.has(product)) return true;
  if (/(warframe|rifle|shotgun|sniper|bow|pistol|melee|sentinel|companion)/.test(type)) {
    return true;
  }
  return false;
}

function canonicalName(value: string = ""): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractPrimeNames(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const matches =
    text.match(
      /(?:Prime\s+[A-Za-z']+(?:\s+[A-Za-z']+)*)|(?:[A-Za-z']+(?:\s+[A-Za-z']+)*\s+Prime)/gi,
    ) || [];
  for (const match of matches) {
    const normalized = match.trim().replace(/\s{2,}/g, " ");
    if (/^prime\s+/i.test(normalized)) {
      const rest = normalized.replace(/^prime\s+/i, "").trim();
      if (rest) out.add(`${rest} Prime`);
    } else {
      out.add(normalized);
    }
  }
  return [...out];
}

interface FeaturedPrime {
  name: string;
  displayName?: string;
  imageUrl: string;
  owned: boolean;
  /** Fed to the Helminth. Refines `owned`, never replaces it. */
  subsumed?: boolean;
  uniqueName: string;
}

type ItemDbLookup = Record<string, ItemDbEntry>;

interface DbByNameEntry extends ItemDbEntry {
  uniqueName: string;
  name: string;
  imageUrl: string;
}

function getInventoryRows(inventoryData: RawInventoryData): Array<{ ItemType?: string }> {
  const keys: Array<keyof RawInventoryData> = [
    "Suits",
    "LongGuns",
    "Pistols",
    "Melee",
    "Sentinels",
    "SentinelWeapons",
    "SpaceSuits",
    "SpaceGuns",
    "SpaceMelee",
    "OperatorAmps",
    "MechSuits",
  ];
  return keys.flatMap((key) =>
    Array.isArray(inventoryData[key]) ? (inventoryData[key] as Array<{ ItemType?: string }>) : [],
  );
}

/** Build a Set of uniqueNames the player owns - covers gear, mods, relics, cosmetics, misc */
export function buildBaroOwnedSet(inventoryData: RawInventoryData | null): Set<string> {
  if (!inventoryData) return new Set();
  const BARO_INV_KEYS: Array<keyof RawInventoryData> = [
    "Suits",
    "LongGuns",
    "Pistols",
    "Melee",
    "Sentinels",
    "SentinelWeapons",
    "SpaceSuits",
    "SpaceGuns",
    "SpaceMelee",
    "OperatorAmps",
    "MechSuits",
    "RawUpgrades",
    "Upgrades",
    "LevelKeys",
    "MiscItems",
    "FlavourItems",
  ];
  const owned = new Set<string>();
  for (const key of BARO_INV_KEYS) {
    const rows = inventoryData[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<{ ItemType?: string }>) {
      if (row.ItemType) owned.add(row.ItemType);
    }
  }
  return owned;
}

export function buildFeaturedPrimes(
  varzia: VaultTrader | null | undefined,
  inventoryData: RawInventoryData | null,
  itemDb: ItemDbLookup,
): FeaturedPrime[] {
  if (!varzia || !itemDb) return [];

  const subsumedSets = buildSubsumedSets(itemDb, inventoryData);
  const ownedUnique = new Set<string>();
  const ownedNames = new Set<string>();
  if (inventoryData) {
    for (const row of getInventoryRows(inventoryData)) {
      if (!row.ItemType) continue;
      ownedUnique.add(row.ItemType);
      const db = itemDb[row.ItemType];
      if (db?.name) ownedNames.add(db.name.toLowerCase());
    }
  }

  const featured: FeaturedPrime[] = [];
  const seen = new Set<string>();

  for (const inv of (varzia.inventory || []) as VaultTraderInventoryItem[]) {
    const db = inv?.uniqueName ? itemDb[inv.uniqueName] : null;
    if (!db?.name || !db.imageUrl || !isResurgenceCandidate(db)) continue;
    const key = db.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const subsumed = isSubsumedFrame(db, inv.uniqueName || "", subsumedSets);
    featured.push({
      name: db.name,
      ...(db.displayName ? { displayName: db.displayName } : {}),
      imageUrl: db.imageUrl,
      owned: ownedUnique.has(inv.uniqueName || "") || ownedNames.has(key) || subsumed,
      ...(subsumed ? { subsumed: true } : {}),
      uniqueName: inv.uniqueName || "",
    });
    if (featured.length >= 9) break;
  }

  if (featured.length < 9) {
    const dbByName = new Map<string, DbByNameEntry>();
    const dbByCanonical = new Map<string, DbByNameEntry>();

    for (const [uniqueName, value] of Object.entries(itemDb)) {
      if (!value?.name || !value.imageUrl) continue;
      const entry: DbByNameEntry = {
        ...value,
        uniqueName,
        name: value.name,
        imageUrl: value.imageUrl,
      };
      dbByName.set(entry.name.toLowerCase(), entry);
      const c = canonicalName(entry.name);
      if (!dbByCanonical.has(c)) dbByCanonical.set(c, entry);
    }

    for (const inv of (varzia.inventory || []) as VaultTraderInventoryItem[]) {
      const db = inv?.uniqueName ? itemDb[inv.uniqueName] : null;
      const raw = (db?.name || inv.item || "")
        .replace(/\bM\s*P\s*V\b/gi, "")
        .replace(/\b(single|dual)\s*pack\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      for (const primeName of extractPrimeNames(raw)) {
        const cleaned = primeName
          .replace(/\bpower suit\b/gi, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        const entry =
          dbByName.get(cleaned.toLowerCase()) || dbByCanonical.get(canonicalName(cleaned));
        if (!entry?.imageUrl || !isResurgenceCandidate(entry)) continue;
        const key = entry.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const subsumed = isSubsumedFrame(entry, entry.uniqueName, subsumedSets);
        featured.push({
          name: entry.name,
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          imageUrl: entry.imageUrl,
          owned:
            (entry.uniqueName && ownedUnique.has(entry.uniqueName)) ||
            ownedNames.has(key) ||
            subsumed,
          ...(subsumed ? { subsumed: true } : {}),
          uniqueName: entry.uniqueName || "",
        });
        if (featured.length >= 9) break;
      }
      if (featured.length >= 9) break;
    }
  }

  return featured;
}

export interface CircuitChoice {
  name: string;
  displayName?: string;
  imageUrl: string;
  owned: boolean;
  /** Fed to the Helminth. Refines `owned`, never replaces it. */
  subsumed?: boolean;
  uniqueName: string;
}

/** Weekly warframe groups of the normal Circuit, in cycle order (wiki-sourced). */
export const CIRCUIT_NORMAL_ROTATION: string[][] = [
  ["Excalibur", "Trinity", "Ember"],
  ["Loki", "Mag", "Rhino"],
  ["Ash", "Frost", "Nyx"],
  ["Saryn", "Vauban", "Nova"],
  ["Nekros", "Valkyr", "Oberon"],
  ["Hydroid", "Mirage", "Limbo"],
  ["Mesa", "Chroma", "Atlas"],
  ["Ivara", "Inaros", "Titania"],
  ["Nidus", "Octavia", "Harrow"],
  ["Gara", "Khora", "Revenant"],
  ["Garuda", "Baruuk", "Hildryn"],
];

/** Live circuit picks for one category ("normal" or "hard"); the world state
 *  groups them, and a missing group reads as no data rather than an error. */
export function circuitChoices(wd: WorldState | null | undefined, category: string): string[] {
  return (wd?.duviriCycle?.choices ?? []).find((set) => set.category === category)?.choices ?? [];
}

const INCARNON_SUFFIX = " incarnon genesis";

// warframestat spells some names differently from DE's export ("Ack And
// Brunt" vs "Ack & Brunt"), so all name matching goes through this key.
function circuitNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Weekly Incarnon Genesis groups of the Steel Path Circuit, in cycle order. */
export const CIRCUIT_HARD_ROTATION: string[][] = [
  ["Braton", "Lato", "Skana", "Paris", "Kunai"],
  ["Boar", "Gammacor", "Angstrum", "Gorgon", "Anku"],
  ["Bo", "Latron", "Furis", "Furax", "Strun"],
  ["Lex", "Magistar", "Boltor", "Bronco", "Ceramic Dagger"],
  ["Torid", "Dual Toxocyst", "Dual Ichor", "Miter", "Atomos"],
  ["Ack & Brunt", "Soma", "Vasto", "Nami Solo", "Burston"],
  ["Zylok", "Sibear", "Dread", "Despair", "Hate"],
  ["Dera", "Sybaris", "Cestra", "Sicarus", "Okina"],
  ["Vectis", "Stug", "Ballistica", "Destreza", "Obex"],
];

// Return -1 when live choices no longer match a known week so callers can fall
// back to current-only data.
export function circuitRotationIndex(rotation: string[][], choices: string[]): number {
  const set = new Set(choices.map(circuitNameKey));
  let best = -1;
  let bestHits = 0;
  rotation.forEach((week, i) => {
    const hits = week.filter((n) => set.has(circuitNameKey(n))).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  });
  return bestHits >= Math.ceil((rotation[best]?.length ?? 2) / 2) ? best : -1;
}

// Subsumed frames count as owned alongside Suits; weapons use their inventory
// collections.
export function resolveCircuitChoices(
  choices: string[],
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): CircuitChoice[] {
  if (!choices.length || !itemDb) return [];
  return circuitResolver(itemDb, inventoryData)(choices);
}

// Each-block key: an item DB that has not loaded yet leaves every uniqueName
// empty, and Svelte throws on duplicate keys, so the requested name backs it up.
export function circuitChoiceKey(choice: Pick<CircuitChoice, "uniqueName" | "name">): string {
  return choice.uniqueName || choice.name;
}

/** Resolve every week of a rotation with a single shared item-db lookup. */
export function resolveCircuitRotation(
  weeks: string[][],
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): CircuitChoice[][] {
  if (!itemDb) return weeks.map(() => []);
  const resolve = circuitResolver(itemDb, inventoryData);
  return weeks.map(resolve);
}

const WARFRAME_CATS = new Set(["warframe", "warframes", "suits"]);

function entryCategory(entry: ItemDbEntry): string {
  return (entry.category || entry.productCategory || "").toLowerCase();
}

interface SubsumedSets {
  uniqueNames: Set<string>;
  families: Set<string>;
}

function buildSubsumedSets(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): SubsumedSets {
  return {
    uniqueNames: new Set(consumedSuitUniqueNames(inventoryData)),
    families: buildSubsumedFamilySet(inventoryData, itemDb),
  };
}

/** Family matching catches the same frame under another uniqueName, but never a
 *  Prime: its base being fed says nothing about the Prime. */
function isSubsumedFrame(entry: ItemDbEntry, uniqueName: string, sets: SubsumedSets): boolean {
  if (!WARFRAME_CATS.has(entryCategory(entry))) return false;
  if (sets.uniqueNames.has(uniqueName)) return true;
  const name = entry.name || "";
  return isSubsumableFrame(name) && isFrameSubsumed(name, sets.families);
}

interface OwnedSets {
  ownedSuits: Set<string>;
  ownedWeapons: Set<string>;
  /** Uninstalled adapter unlockers sitting in MiscItems, by uniqueName. */
  ownedAdapterTypes: Set<string>;
  /** Base-weapon name keys whose adapter is installed (Features bit on a weapon). */
  installedIncarnonKeys: Set<string>;
  subsumed: SubsumedSets;
}

// EquipmentFeatures.INCARNON_GENESIS per SpaceNinjaServer; set on the weapon
// instance once the adapter is installed (and consumed from MiscItems).
const INCARNON_GENESIS_FEATURE = 512;

/** Adapters fit every variant of their weapon (Prisma Skana, Dex Furis, Braton
 *  Vandal all take the base adapter), so installed detection folds variants.
 *  Not config/shared/weaponVariants: that list is riven families, and folding
 *  Kuva Karak to Karak here would read the base weapon's adapter as installed. */
function incarnonBaseName(name: string): string {
  return name.replace(/^(MK1-|Prisma |Mara |Dex )/i, "").replace(/ (Prime|Vandal|Wraith)$/i, "");
}

function buildOwnedSets(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): OwnedSets {
  const ownedSuits = new Set<string>();
  const ownedWeapons = new Set<string>();
  const ownedAdapterTypes = new Set<string>();
  const installedIncarnonKeys = new Set<string>();
  if (inventoryData) {
    for (const suit of (inventoryData.Suits || []) as Array<{ ItemType?: string }>) {
      if (suit.ItemType) ownedSuits.add(suit.ItemType);
    }
    for (const misc of (inventoryData.MiscItems || []) as Array<{ ItemType?: string }>) {
      if (misc.ItemType?.includes("/IncarnonAdapters/")) ownedAdapterTypes.add(misc.ItemType);
    }
    const weaponKeys: Array<keyof RawInventoryData> = ["LongGuns", "Pistols", "Melee"];
    for (const k of weaponKeys) {
      const rows = (inventoryData[k] || []) as Array<{ ItemType?: string; Features?: number }>;
      for (const wpn of rows) {
        if (!wpn.ItemType) continue;
        ownedWeapons.add(wpn.ItemType);
        if (typeof wpn.Features === "number" && wpn.Features & INCARNON_GENESIS_FEATURE) {
          const name = itemDb[wpn.ItemType]?.name;
          if (name) installedIncarnonKeys.add(circuitNameKey(incarnonBaseName(name)));
        }
      }
    }
  }
  return {
    ownedSuits,
    ownedWeapons,
    ownedAdapterTypes,
    installedIncarnonKeys,
    subsumed: buildSubsumedSets(itemDb, inventoryData),
  };
}

interface ResolvedEntry extends ItemDbEntry {
  uniqueName: string;
  name: string;
  imageUrl: string;
}

/** Owning the base weapon says nothing about the adapter reward. */
function incarnonAdapterOwned(
  adapterUniqueName: string,
  baseKey: string,
  sets: OwnedSets,
): boolean {
  return sets.ownedAdapterTypes.has(adapterUniqueName) || sets.installedIncarnonKeys.has(baseKey);
}

/** A fed frame left Suits but is still owned, so this refines `owned`, never replaces it. */
function toCircuitChoice(entry: ResolvedEntry, sets: OwnedSets): CircuitChoice {
  const subsumed = isSubsumedFrame(entry, entry.uniqueName, sets.subsumed);
  const nameKey = circuitNameKey(entry.name);
  const owned = nameKey.endsWith(INCARNON_SUFFIX)
    ? incarnonAdapterOwned(entry.uniqueName, nameKey.slice(0, -INCARNON_SUFFIX.length), sets)
    : WARFRAME_CATS.has(entryCategory(entry))
      ? sets.ownedSuits.has(entry.uniqueName) || subsumed
      : sets.ownedWeapons.has(entry.uniqueName);
  return {
    name: entry.name,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    imageUrl: entry.imageUrl,
    owned,
    ...(subsumed ? { subsumed: true } : {}),
    uniqueName: entry.uniqueName,
  };
}

/** Vendor stock arrives as uniqueNames; entries the item DB cannot picture are
 *  dropped rather than rendered as empty tiles (bundles, decorations). */
export function resolveVendorItems(
  uniqueNames: string[],
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): CircuitChoice[] {
  if (!uniqueNames.length || !itemDb) return [];
  const sets = buildOwnedSets(itemDb, inventoryData);
  const resolved: CircuitChoice[] = [];
  for (const uniqueName of uniqueNames) {
    const entry = itemDb[uniqueName];
    if (!entry?.name || !entry.imageUrl) continue;
    resolved.push(
      toCircuitChoice({ ...entry, uniqueName, name: entry.name, imageUrl: entry.imageUrl }, sets),
    );
  }
  return resolved;
}

function circuitResolver(
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): (names: string[]) => CircuitChoice[] {
  const byName = new Map<string, ResolvedEntry>();
  // Steel Path rewards the Incarnon Genesis adapter, so its art is the evolved weapon.
  const incarnonArt = new Map<string, string>();
  const incarnonAdapters = new Map<string, string>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    if (!entry?.name || !entry.imageUrl) continue;
    const key = circuitNameKey(entry.name);
    if (!byName.has(key)) {
      byName.set(key, { ...entry, uniqueName, name: entry.name, imageUrl: entry.imageUrl });
    }
    const base = key.endsWith(INCARNON_SUFFIX) ? key.slice(0, -INCARNON_SUFFIX.length) : null;
    if (base && !incarnonArt.has(base)) incarnonArt.set(base, entry.imageUrl);
    if (base && !incarnonAdapters.has(base)) incarnonAdapters.set(base, uniqueName);
  }

  const sets = buildOwnedSets(itemDb, inventoryData);

  return (names) =>
    names.map((name) => {
      const baseKey = circuitNameKey(name);
      const match = byName.get(baseKey);
      if (!match) return { name, imageUrl: "", owned: false, uniqueName: "" };

      const imageUrl = incarnonArt.get(baseKey) || match.imageUrl;
      const choice = toCircuitChoice({ ...match, imageUrl }, sets);
      // Steel Path rewards the adapter, so ownership tracks the adapter (spare
      // unlocker or installed on any weapon variant), never the base weapon.
      const adapter = incarnonAdapters.get(baseKey);
      if (adapter) choice.owned = incarnonAdapterOwned(adapter, baseKey, sets);
      return choice;
    });
}
