import { entryInstanceId } from "./entryNormalization.js";
import type { MessageKey } from "../i18n.js";
import type {
  ItemDbEntry,
  RawArchonCrystalUpgrade,
  RawInventoryData,
  RawInventoryEntry,
  RawSuitEntry,
} from "../../types/inventory.js";

export type ArchonShardColor = "crimson" | "amber" | "azure" | "emerald" | "topaz" | "violet";

/** Display order, matching the in-game shard rack. */
const ARCHON_SHARD_COLORS: readonly ArchonShardColor[] = [
  "crimson",
  "amber",
  "azure",
  "emerald",
  "topaz",
  "violet",
];

// A socketed shard records its hue as ACC_<hue>; the _MYTHIC suffix is tauforged.
const COLOR_BY_ACC: Readonly<Record<string, ArchonShardColor>> = {
  ACC_RED: "crimson",
  ACC_YELLOW: "amber",
  ACC_BLUE: "azure",
  ACC_GREEN: "emerald",
  ACC_ORANGE: "topaz",
  ACC_PURPLE: "violet",
};

// Loose shards sit in MiscItems named after the Archon that drops them.
const COLOR_BY_LOOSE_ITEM: Readonly<Record<string, ArchonShardColor>> = {
  ArchonCrystalAmar: "crimson",
  ArchonCrystalNira: "amber",
  ArchonCrystalBoreal: "azure",
  ArchonCrystalGreen: "emerald",
  ArchonCrystalOrange: "topaz",
  ArchonCrystalViolet: "violet",
};

const ARCHON_SHARD_ITEM_PATH = "/Lotus/Types/Gameplay/NarmerSorties/";

// Inverted so the icon lookup and the loose-shard parse can never disagree.
const LOOSE_ITEM_BY_COLOR = Object.fromEntries(
  Object.entries(COLOR_BY_LOOSE_ITEM).map(([leaf, color]) => [color, leaf]),
) as Record<ArchonShardColor, string>;

/** PublicExport MiscItem uniqueName for a shard kind; tauforged is `Mythic`. */
export function archonShardUniqueName(color: ArchonShardColor, tauforged: boolean): string {
  return `${ARCHON_SHARD_ITEM_PATH}${LOOSE_ITEM_BY_COLOR[color]}${tauforged ? "Mythic" : ""}`;
}

/** Real shard art from the item database. Null whenever the database has not
 *  loaded or DE renamed the item, so callers keep their coloured-dot fallback. */
export function archonShardIconUrl(
  db: Record<string, ItemDbEntry>,
  color: ArchonShardColor | null,
  tauforged: boolean,
): string | null {
  if (!color) return null;
  return db[archonShardUniqueName(color, tauforged)]?.imageUrl ?? null;
}

/** Sockets a Warframe has. DE only sends up to the highest used one, so the tail
 *  is a display-side assumption and never feeds a count. */
export const ARCHON_SHARD_SLOT_COUNT = 5;

export interface ArchonShardSlot {
  index: number;
  /** Null for an empty socket, or a filled one whose colour DE did not send. */
  color: ArchonShardColor | null;
  tauforged: boolean;
  filled: boolean;
  upgradeType: string | null;
}

interface SuitArchonShards {
  /** Warframe uniqueName, matching `ItemDbEntry` keys and mastery `uniqueName`. */
  itemType: string;
  /** Shards belong to one copy of a frame, so rows key off the instance. */
  instanceId: string | null;
  /** Exactly the sockets DE sent, in payload order. */
  slots: ArchonShardSlot[];
  filled: number;
}

interface ArchonShardData {
  suits: SuitArchonShards[];
  /** Frame uniqueName to its owned copies that carry at least one socket entry. */
  bySuitType: Map<string, SuitArchonShards[]>;
  /** Unsocketed shards, keyed by `shardKindKey`. */
  loose: Map<string, number>;
}

interface ArchonShardHolder {
  itemType: string;
  instanceId: string | null;
  count: number;
}

export interface ArchonShardStock {
  color: ArchonShardColor;
  tauforged: boolean;
  installed: number;
  unsocketed: number;
  total: number;
  /** Frames carrying this kind, most-loaded first. */
  holders: ArchonShardHolder[];
}

export interface ArchonShardSummary {
  stock: ArchonShardStock[];
  installed: number;
  unsocketed: number;
  /** Filled sockets whose colour DE omitted or we do not recognise. */
  unknownInstalled: number;
  suitsWithShards: number;
}

export function shardKindKey(color: ArchonShardColor, tauforged: boolean): string {
  return tauforged ? `${color}:tau` : color;
}

const COLOR_MESSAGE_KEYS: Readonly<Record<ArchonShardColor, MessageKey>> = {
  crimson: "archon.color.crimson",
  amber: "archon.color.amber",
  azure: "archon.color.azure",
  emerald: "archon.color.emerald",
  topaz: "archon.color.topaz",
  violet: "archon.color.violet",
};

export function archonShardColorKey(color: ArchonShardColor): MessageKey {
  return COLOR_MESSAGE_KEYS[color];
}

/** Readable effect name from the DE upgrade uniqueName. Game data, so English,
 *  and derived rather than curated so a new shard effect still reads sanely. */
export function archonShardUpgradeLabel(upgradeType: string | null | undefined): string {
  if (!upgradeType) return "";
  const leaf = (upgradeType.split("/").pop() || "")
    .replace(/^ArchonCrystalUpgrade/, "")
    .replace(/Mythic$/, "");
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^Warframe\s+/, "")
    .trim();
}

/** Pads the payload's sockets out to a full rack for the detail view. DE sends
 *  only up to the highest used socket, so the tail is presentation, not a count. */
export function archonShardDisplaySlots(slots: ArchonShardSlot[]): ArchonShardSlot[] {
  const out = [...slots];
  for (let index = out.length; index < ARCHON_SHARD_SLOT_COUNT; index += 1) {
    out.push({ index, color: null, tauforged: false, filled: false, upgradeType: null });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSlot(entry: unknown, index: number): ArchonShardSlot {
  const record = asRecord(entry) as RawArchonCrystalUpgrade | null;
  const upgradeType = typeof record?.UpgradeType === "string" ? record.UpgradeType : null;
  const rawColor = typeof record?.Color === "string" ? record.Color : "";
  const tauforged = rawColor.endsWith("_MYTHIC") || (upgradeType?.endsWith("Mythic") ?? false);
  const color = COLOR_BY_ACC[rawColor.replace("_MYTHIC", "")] ?? null;
  return {
    index,
    color,
    tauforged: tauforged && (color !== null || upgradeType !== null),
    filled: upgradeType !== null || color !== null,
    upgradeType,
  };
}

function parseSuit(entry: RawSuitEntry): SuitArchonShards | null {
  const itemType = typeof entry.ItemType === "string" ? entry.ItemType : "";
  if (!itemType || !Array.isArray(entry.ArchonCrystalUpgrades)) return null;
  const slots = entry.ArchonCrystalUpgrades.map(parseSlot);
  const filled = slots.reduce((sum, slot) => sum + (slot.filled ? 1 : 0), 0);
  if (filled === 0) return null;
  return { itemType, instanceId: entryInstanceId(entry), slots, filled };
}

function looseShardColor(
  itemType: unknown,
): { color: ArchonShardColor; tauforged: boolean } | null {
  if (typeof itemType !== "string") return null;
  const leaf = itemType.split("/").pop() || "";
  const tauforged = leaf.endsWith("Mythic");
  const color = COLOR_BY_LOOSE_ITEM[tauforged ? leaf.slice(0, -"Mythic".length) : leaf];
  return color ? { color, tauforged } : null;
}

function collectLoose(items: unknown): Map<string, number> {
  const loose = new Map<string, number>();
  if (!Array.isArray(items)) return loose;
  for (const raw of items) {
    const entry = asRecord(raw) as RawInventoryEntry | null;
    if (!entry) continue;
    const kind = looseShardColor(entry.ItemType);
    if (!kind) continue;
    const count = typeof entry.ItemCount === "number" ? Math.trunc(entry.ItemCount) : 0;
    if (count <= 0) continue;
    const key = shardKindKey(kind.color, kind.tauforged);
    loose.set(key, (loose.get(key) ?? 0) + count);
  }
  return loose;
}

/** Derived only: stale inventory under-reports shards, which stays harmless
 *  because nothing here is ever written back or cached. */
export function parseArchonShards(inv: RawInventoryData | null | undefined): ArchonShardData {
  const suits: SuitArchonShards[] = [];
  const bySuitType = new Map<string, SuitArchonShards[]>();
  if (!inv) return { suits, bySuitType, loose: new Map() };

  for (const raw of Array.isArray(inv.Suits) ? inv.Suits : []) {
    const entry = asRecord(raw) as RawSuitEntry | null;
    const parsed = entry ? parseSuit(entry) : null;
    if (!parsed) continue;
    suits.push(parsed);
    const existing = bySuitType.get(parsed.itemType);
    if (existing) existing.push(parsed);
    else bySuitType.set(parsed.itemType, [parsed]);
  }

  return { suits, bySuitType, loose: collectLoose(inv.MiscItems) };
}

export function summarizeArchonShards(data: ArchonShardData): ArchonShardSummary {
  const stock = new Map<string, ArchonShardStock>();
  let installed = 0;
  let unknownInstalled = 0;

  const stockFor = (color: ArchonShardColor, tauforged: boolean): ArchonShardStock => {
    const key = shardKindKey(color, tauforged);
    let row = stock.get(key);
    if (!row) {
      row = { color, tauforged, installed: 0, unsocketed: 0, total: 0, holders: [] };
      stock.set(key, row);
    }
    return row;
  };

  for (const suit of data.suits) {
    const perKind = new Map<string, number>();
    for (const slot of suit.slots) {
      if (!slot.filled) continue;
      installed += 1;
      if (!slot.color) {
        unknownInstalled += 1;
        continue;
      }
      const key = shardKindKey(slot.color, slot.tauforged);
      perKind.set(key, (perKind.get(key) ?? 0) + 1);
      stockFor(slot.color, slot.tauforged).installed += 1;
    }
    for (const [key, count] of perKind) {
      const row = stock.get(key);
      if (row) row.holders.push({ itemType: suit.itemType, instanceId: suit.instanceId, count });
    }
  }

  let unsocketed = 0;
  for (const [key, count] of data.loose) {
    const tauforged = key.endsWith(":tau");
    const color = (tauforged ? key.slice(0, -":tau".length) : key) as ArchonShardColor;
    stockFor(color, tauforged).unsocketed += count;
    unsocketed += count;
  }

  const rows = [...stock.values()].filter((row) => row.installed + row.unsocketed > 0);
  for (const row of rows) {
    row.total = row.installed + row.unsocketed;
    row.holders.sort((a, b) => b.count - a.count || a.itemType.localeCompare(b.itemType));
  }
  // Tauforged after the plain shard of the same colour, colours in rack order.
  rows.sort(
    (a, b) =>
      ARCHON_SHARD_COLORS.indexOf(a.color) - ARCHON_SHARD_COLORS.indexOf(b.color) ||
      Number(a.tauforged) - Number(b.tauforged),
  );

  return {
    stock: rows,
    installed,
    unsocketed,
    unknownInstalled,
    suitsWithShards: data.suits.length,
  };
}
