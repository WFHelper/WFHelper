import type { ItemDbEntry, RawInventoryData } from "../types/inventory.js";
import type { VaultTrader, VaultTraderInventoryItem } from "../types/world.js";
import { RELIC_ICON_PATHS, fissureTierClass } from "./relic/relicConstants.js";

export { RELIC_ICON_PATHS, fissureTierClass };

export const PLANET_ICON_PATHS: Record<string, string> = {
  earth: "world-icons/earth.webp",
  cetus: "world-icons/earth.webp",
  vallis: "world-icons/vallis.webp",
  cambion: "world-icons/cambion.webp",
  duviri: "world-icons/zariman.webp",
} as const;

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

export function isResurgenceCandidate(entry: ItemDbEntry = {}): boolean {
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
  imageUrl: string;
  owned: boolean;
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

/** Build a Set of uniqueNames the player owns — covers gear, mods, relics, cosmetics, misc */
export function buildBaroOwnedSet(inventoryData: RawInventoryData | null): Set<string> {
  if (!inventoryData) return new Set();
  const BARO_INV_KEYS: Array<keyof RawInventoryData> = [
    "Suits", "LongGuns", "Pistols", "Melee",
    "Sentinels", "SentinelWeapons", "SpaceSuits", "SpaceGuns", "SpaceMelee",
    "OperatorAmps", "MechSuits",
    "RawUpgrades", "Upgrades",
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
    featured.push({
      name: db.name,
      imageUrl: db.imageUrl,
      owned: ownedUnique.has(inv.uniqueName || "") || ownedNames.has(key),
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
        featured.push({
          name: entry.name,
          imageUrl: entry.imageUrl,
          owned: (entry.uniqueName && ownedUnique.has(entry.uniqueName)) || ownedNames.has(key),
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
  imageUrl: string;
  owned: boolean;
  uniqueName: string;
}

/**
 * Resolve circuit choice names to images and ownership.
 * Warframes: owned if found in inventory Suits OR subsumed (ConsumedSuits).
 * Weapons: owned if found in weapon inventory (LongGuns/Pistols/Melee).
 */
export function resolveCircuitChoices(
  choices: string[],
  itemDb: Record<string, ItemDbEntry>,
  inventoryData: RawInventoryData | null,
): CircuitChoice[] {
  if (!choices.length || !itemDb) return [];

  // Build name → { uniqueName, imageUrl, category } lookup
  const byName = new Map<string, { uniqueName: string; imageUrl: string; category: string }>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    if (!entry?.name || !entry.imageUrl) continue;
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        uniqueName,
        imageUrl: entry.imageUrl,
        category: (entry.category || entry.productCategory || "").toLowerCase(),
      });
    }
  }

  // Build ownership sets
  const ownedSuits = new Set<string>();
  const ownedWeapons = new Set<string>();
  if (inventoryData) {
    // Warframes currently in inventory
    for (const suit of (inventoryData.Suits || []) as Array<{ ItemType?: string }>) {
      if (suit.ItemType) ownedSuits.add(suit.ItemType);
    }
    // Warframes subsumed to Helminth (no longer in Suits but still "owned")
    const consumedSuits = (
      (inventoryData as Record<string, unknown>).InfestedFoundry as
        | { ConsumedSuits?: Array<{ s?: string }> }
        | undefined
    )?.ConsumedSuits;
    if (Array.isArray(consumedSuits)) {
      for (const entry of consumedSuits) {
        if (entry.s) ownedSuits.add(entry.s);
      }
    }
    // Weapons
    const weaponKeys: Array<keyof RawInventoryData> = ["LongGuns", "Pistols", "Melee"];
    for (const k of weaponKeys) {
      for (const wpn of (inventoryData[k] || []) as Array<{ ItemType?: string }>) {
        if (wpn.ItemType) ownedWeapons.add(wpn.ItemType);
      }
    }
  }

  const WARFRAME_CATS = new Set(["warframe", "warframes", "suits"]);

  return choices.map((name) => {
    const match = byName.get(name.toLowerCase());
    if (!match) return { name, imageUrl: "", owned: false, uniqueName: "" };

    const isFrame = WARFRAME_CATS.has(match.category);
    const owned = isFrame
      ? ownedSuits.has(match.uniqueName)
      : ownedWeapons.has(match.uniqueName);

    return { name, imageUrl: match.imageUrl, owned, uniqueName: match.uniqueName };
  });
}
