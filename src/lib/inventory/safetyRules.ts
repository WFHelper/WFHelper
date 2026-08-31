import { componentUniqueNameAliases } from "../../../config/shared/componentNames.js";
import { getFullSetOverride } from "./fullSetOverrides.js";
import { setRootOf } from "./fullSets.js";
import type { InventoryGroup, ItemDbEntry } from "../../types/inventory.js";

/** Every rule states a floor of copies that must stay in the account and the
 *  highest wins. Summing them instead would double one rule with another and
 *  could reserve more than the account holds. */
export type SafetyRuleId =
  | "lock"
  | "built"
  | "equipped"
  | "lastCopy"
  | "spare"
  | "pinnedGoal"
  | "unmasteredRecipe"
  | "setKeep";

type SafetyReasonKey =
  | "inventory.safety.reason.locked"
  | "inventory.safety.reason.builtEquipment"
  | "inventory.safety.reason.untradable"
  | "inventory.safety.reason.equipped"
  | "inventory.safety.reason.lastCopy"
  | "inventory.safety.reason.spare"
  | "inventory.safety.reason.pinnedGoal"
  | "inventory.safety.reason.unmasteredRecipe"
  | "inventory.safety.reason.setKeep";

export const SAFETY_REASON_KEYS: readonly SafetyReasonKey[] = [
  "inventory.safety.reason.locked",
  "inventory.safety.reason.builtEquipment",
  "inventory.safety.reason.untradable",
  "inventory.safety.reason.equipped",
  "inventory.safety.reason.lastCopy",
  "inventory.safety.reason.spare",
  "inventory.safety.reason.pinnedGoal",
  "inventory.safety.reason.unmasteredRecipe",
  "inventory.safety.reason.setKeep",
];

export interface SafetyReservation {
  rule: SafetyRuleId;
  /** Copies this rule alone insists on keeping. Floors compose by max, so this
   *  can exceed `reserved` when the account is short of what the rule wants. */
  quantity: number;
  /** True for the rule (or tied rules) that set `reserved`. */
  binding: boolean;
  reasonKey: SafetyReasonKey;
  params?: Readonly<Record<string, string | number>>;
}

export interface SafetyVerdict {
  total: number;
  /** Copies actually held back: the highest floor, clamped to `total`. */
  reserved: number;
  safe: number;
  reservations: readonly SafetyReservation[];
}

/** The inventory fields the engine reads. `ParsedItem` satisfies it structurally. */
export interface SafetyItem {
  internalName: string;
  uniqueName?: string;
  amount?: number | null;
  inventoryGroup?: InventoryGroup;
  rank?: number;
  leveledUp?: boolean;
  equipped?: boolean;
  tradable?: boolean;
}

export interface InventorySafetySettings {
  /** Copies kept on every row that has no override. */
  spareDefault: number;
  /** Safety key -> copies to keep. Present-and-zero overrides the default. */
  spares: Readonly<Record<string, number>>;
  /** Safety keys the user marked never-list. */
  locks: readonly string[];
  /** Set root uniqueNames to keep one assembled set of. */
  setKeep: readonly string[];
}

export const DEFAULT_SAFETY_SETTINGS: InventorySafetySettings = Object.freeze({
  spareDefault: 0,
  spares: Object.freeze({}),
  locks: Object.freeze([]) as readonly string[],
  setKeep: Object.freeze([]) as readonly string[],
});

const SPARE_MAX = 999;
const KEY_LIST_MAX = 2000;

function toCount(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Item keys are DE paths, so a prototype name only ever arrives as junk. */
function isUsableKey(key: string): boolean {
  return Boolean(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function normalizeKeyList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  // Bound the scan too: a corrupt blob can be far longer than the entry cap.
  const limit = Math.min(value.length, KEY_LIST_MAX * 4);
  for (let index = 0; index < limit && seen.size < KEY_LIST_MAX; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry === "string" && isUsableKey(entry)) seen.add(entry);
  }
  return [...seen];
}

function normalizeSpares(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const spares: Record<string, number> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isUsableKey(key) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
    spares[key] = Math.min(SPARE_MAX, Math.max(0, Math.floor(raw)));
    if (++kept >= KEY_LIST_MAX) break;
  }
  return spares;
}

/** Anything the store read back becomes valid settings or the defaults. */
export function normalizeSafetySettings(raw: unknown): InventorySafetySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_SAFETY_SETTINGS;
  const source = raw as Record<string, unknown>;
  return {
    spareDefault: Math.min(SPARE_MAX, toCount(source.spareDefault, 0)),
    spares: normalizeSpares(source.spares),
    locks: normalizeKeyList(source.locks),
    setKeep: normalizeKeyList(source.setKeep),
  };
}

interface SetPart {
  uniqueName?: string;
  itemCount?: number;
}

interface SafetyContextInput {
  itemDb: Record<string, ItemDbEntry>;
  settings?: InventorySafetySettings;
  /** Mastered uniqueNames. Absent leaves the unmastered-recipe rule degraded. */
  masteredUniqueNames?: ReadonlySet<string>;
  /** uniqueName -> units pinned goals need kept. The pin store owns the walk
   *  from a goal to this flat map; the engine only reads it. */
  pinnedRequirements?: ReadonlyMap<string, number>;
}

export interface SafetyContext {
  readonly itemDb: Record<string, ItemDbEntry>;
  readonly spareDefault: number;
  readonly spares: ReadonlyMap<string, number>;
  readonly locks: ReadonlySet<string>;
  readonly setKeepRoots: ReadonlySet<string>;
  readonly pinnedDemand: ReadonlyMap<string, number>;
  readonly unmasteredDemand: ReadonlyMap<string, number>;
  readonly setKeepDemand: ReadonlyMap<string, number>;
  /** Rules with no data to work with. They never fire, and the caller should say so. */
  readonly degradedRules: readonly SafetyRuleId[];
}

/** Set parts of a root, override list first - the item DB cannot rebuild those. */
function partsOf(root: string, entry: ItemDbEntry | undefined): readonly SetPart[] {
  const override = getFullSetOverride(root);
  if (override) return override.components;
  return Array.isArray(entry?.components) ? entry.components : [];
}

/** Demand is written under every alias so a lookup by either spelling hits it. */
function addPartDemand(demand: Map<string, number>, parts: readonly SetPart[], sets: number): void {
  for (const part of parts) {
    const uniqueName = typeof part.uniqueName === "string" ? part.uniqueName : "";
    if (!uniqueName) continue;
    // Same reading of itemCount as fullSets.ts, so both consumers of one
    // component list agree that a missing or zero count still means one part.
    const required = toCount(part.itemCount, 1) || 1;
    const need = required * sets;
    if (need <= 0) continue;
    for (const alias of componentUniqueNameAliases(uniqueName)) {
      demand.set(alias, (demand.get(alias) ?? 0) + need);
    }
  }
}

function demandFor(demand: ReadonlyMap<string, number>, aliases: readonly string[]): number {
  let units = 0;
  for (const alias of aliases) units = Math.max(units, demand.get(alias) ?? 0);
  return units;
}

function resolveDbEntry(
  itemDb: Record<string, ItemDbEntry>,
  aliases: readonly string[],
): ItemDbEntry | undefined {
  for (const alias of aliases) {
    const entry = itemDb[alias];
    if (entry) return entry;
  }
  return undefined;
}

/** Units of a product to copies of the row that supplies them. A blueprint
 *  yielding several per craft needs proportionally fewer copies, and a reusable
 *  one needs exactly one however large the demand. */
export function reserveUnitsToCopies(units: number, entry: ItemDbEntry | undefined): number {
  if (units <= 0) return 0;
  if (entry?.reusableBlueprint === true) return 1;
  const num = entry?.recipe?.num;
  if (typeof num === "number" && Number.isFinite(num) && num > 1) return Math.ceil(units / num);
  return units;
}

/** Identity locks and per-item spares are stored under. Synthetic set rows keep
 *  their `#set` internalName, so a kept set never collides with its root item. */
export function safetyKeyFor(item: SafetyItem): string {
  return item.uniqueName || item.internalName;
}

/** Precompute once per inventory generation; `safeToList` is then O(1) per row. */
export function buildSafetyContext(input: SafetyContextInput): SafetyContext {
  const itemDb = input.itemDb ?? {};
  const settings = normalizeSafetySettings(input.settings ?? DEFAULT_SAFETY_SETTINGS);
  const degradedRules: SafetyRuleId[] = [];

  const pinnedDemand = new Map<string, number>();
  if (input.pinnedRequirements) {
    for (const [uniqueName, count] of input.pinnedRequirements) {
      const units = toCount(count, 0);
      if (!uniqueName || units <= 0) continue;
      // Aliases of one pile carry the same figure, so max keeps a map that
      // already lists both spellings from double-counting it.
      for (const alias of componentUniqueNameAliases(uniqueName)) {
        pinnedDemand.set(alias, Math.max(pinnedDemand.get(alias) ?? 0, units));
      }
    }
  } else {
    degradedRules.push("pinnedGoal");
  }

  const unmasteredDemand = new Map<string, number>();
  const mastered = input.masteredUniqueNames;
  if (mastered) {
    for (const [uniqueName, entry] of Object.entries(itemDb)) {
      if (entry?.masterable !== true || mastered.has(uniqueName)) continue;
      addPartDemand(unmasteredDemand, partsOf(uniqueName, entry), 1);
    }
  } else {
    degradedRules.push("unmasteredRecipe");
  }

  const setKeepRoots = new Set(settings.setKeep);
  const setKeepDemand = new Map<string, number>();
  for (const root of setKeepRoots) {
    addPartDemand(setKeepDemand, partsOf(root, itemDb[root]), 1);
  }

  return {
    itemDb,
    spareDefault: settings.spareDefault,
    spares: new Map(Object.entries(settings.spares)),
    locks: new Set(settings.locks),
    setKeepRoots,
    pinnedDemand,
    unmasteredDemand,
    setKeepDemand,
    degradedRules,
  };
}

type SafetyFloor = Omit<SafetyReservation, "binding">;

function floor(
  rule: SafetyRuleId,
  quantity: number,
  reasonKey: SafetyReasonKey,
  params?: Readonly<Record<string, string | number>>,
): SafetyFloor {
  return params ? { rule, quantity, reasonKey, params } : { rule, quantity, reasonKey };
}

export function safeToList(item: SafetyItem, context: SafetyContext): SafetyVerdict {
  const total = toCount(item.amount, 1);
  const key = safetyKeyFor(item);
  const aliases = componentUniqueNameAliases(key);
  const entry = resolveDbEntry(context.itemDb, aliases);
  const floors: SafetyFloor[] = [];

  if (context.locks.has(key)) {
    floors.push(floor("lock", total, "inventory.safety.reason.locked"));
  }

  // Unranked gear still trades; the moment it gains a rank the game binds it.
  const builtEquipment =
    item.inventoryGroup === "equipment" && (toCount(item.rank, 0) > 0 || item.leveledUp === true);
  if (builtEquipment) {
    floors.push(floor("built", total, "inventory.safety.reason.builtEquipment"));
  } else if (item.tradable === false) {
    floors.push(floor("built", total, "inventory.safety.reason.untradable"));
  }

  if (item.equipped === true && total > 0) {
    // A row merges every copy of one rank and only the fitted instance is
    // pinned, so this protects one copy rather than the whole pile.
    floors.push(floor("equipped", 1, "inventory.safety.reason.equipped"));
  }

  const masterable = entry?.masterable === true || item.inventoryGroup === "equipment";
  if (masterable && total > 0) {
    floors.push(floor("lastCopy", 1, "inventory.safety.reason.lastCopy"));
  }

  const spare = context.spares.get(key) ?? context.spareDefault;
  if (spare > 0) {
    floors.push(floor("spare", spare, "inventory.safety.reason.spare", { count: spare }));
  }

  const pinnedCopies = reserveUnitsToCopies(demandFor(context.pinnedDemand, aliases), entry);
  if (pinnedCopies > 0) {
    floors.push(
      floor("pinnedGoal", pinnedCopies, "inventory.safety.reason.pinnedGoal", {
        count: pinnedCopies,
      }),
    );
  }

  const recipeCopies = reserveUnitsToCopies(demandFor(context.unmasteredDemand, aliases), entry);
  if (recipeCopies > 0) {
    floors.push(
      floor("unmasteredRecipe", recipeCopies, "inventory.safety.reason.unmasteredRecipe", {
        count: recipeCopies,
      }),
    );
  }

  const keptSetRow =
    item.inventoryGroup === "full_sets" && context.setKeepRoots.has(setRootOf(item.internalName));
  const setCopies = Math.max(
    reserveUnitsToCopies(demandFor(context.setKeepDemand, aliases), entry),
    keptSetRow ? 1 : 0,
  );
  if (setCopies > 0) {
    floors.push(
      floor("setKeep", setCopies, "inventory.safety.reason.setKeep", { count: setCopies }),
    );
  }

  let highest = 0;
  for (const candidate of floors) highest = Math.max(highest, candidate.quantity);
  const reserved = Math.min(total, highest);

  return {
    total,
    reserved,
    safe: total - reserved,
    reservations: floors.map((candidate) => ({
      ...candidate,
      binding: candidate.quantity === highest,
    })),
  };
}
