import type { InventoryGroup, RawInventoryEntry } from "../../types/inventory.js";
import { pickNumeric, deepFindNumericByKeys } from "./rankExtraction.js";


const EQUIP_CONTEXT_KEYS = new Set([
  "equippedon",
  "installedon",
  "ownername",
  "hostitemname",
  "weaponname",
  "warframename",
  "companionname",
]);


export function pickBoolean(entry: RawInventoryEntry, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
    }
  }
  return undefined;
}

export function parseAmount(entry: RawInventoryEntry): number {
  const raw =
    pickNumeric(entry, ["ItemCount", "Count", "StackCount", "Quantity"]) ??
    deepFindNumericByKeys(entry, new Set(["itemcount", "count", "stackcount", "quantity"])) ??
    1;
  return raw > 0 ? Math.floor(raw) : 1;
}


function isDisplayableEquipContext(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length < 3) return false;
  if (trimmed.length > 60) return false;
  if (trimmed.startsWith("/Lotus/")) return false;
  if (/^[A-Za-z]:\\/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    trimmed.includes("{") ||
    trimmed.includes("}") ||
    trimmed.includes('"') ||
    trimmed.includes("`")
  ) {
    return false;
  }
  if (/^[a-f0-9]{16,}$/i.test(trimmed)) return false;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) {
    return false;
  }
  if (!/[A-Za-z]{3,}/.test(trimmed)) return false;
  return true;
}

function collectEquipContexts(
  value: unknown,
  contexts: Set<string>,
  maxDepth = 3,
  depth = 0,
  captureStrings = false,
): void {
  if (depth > maxDepth || value == null) return;

  if (typeof value === "string") {
    if (captureStrings && isDisplayableEquipContext(value)) {
      contexts.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEquipContexts(entry, contexts, maxDepth, depth + 1, captureStrings);
    }
    return;
  }

  if (typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    const nextCapture = captureStrings || EQUIP_CONTEXT_KEYS.has(normalized);
    collectEquipContexts(nested, contexts, maxDepth, depth + 1, nextCapture);
  }
}

export function extractEquipContexts(entry: RawInventoryEntry): string[] {
  const contexts = new Set<string>();
  collectEquipContexts(entry, contexts);
  return [...contexts].slice(0, 4);
}


export function normalizeCollectionEntries(
  value: unknown,
  maxDepth = 4,
  depth = 0,
): RawInventoryEntry[] {
  if (depth > maxDepth || value == null) return [];

  if (Array.isArray(value)) {
    const flattened: RawInventoryEntry[] = [];
    for (const entry of value) {
      flattened.push(...normalizeCollectionEntries(entry, maxDepth, depth + 1));
    }
    return flattened;
  }

  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (typeof record.ItemType === "string") {
    return [record as RawInventoryEntry];
  }

  const flattened: RawInventoryEntry[] = [];
  for (const nested of Object.values(record)) {
    flattened.push(...normalizeCollectionEntries(nested, maxDepth, depth + 1));
  }
  return flattened;
}


export function preferGroup(
  current: InventoryGroup | undefined,
  next: InventoryGroup,
): InventoryGroup {
  const GROUP_PRIORITY: Record<InventoryGroup, number> = {
    misc: 1,
    all_parts: 2,
    arcanes: 3,
    mods: 4,
    relics: 5,
    full_sets: 6,
  };
  if (!current) return next;
  return GROUP_PRIORITY[next] > GROUP_PRIORITY[current] ? next : current;
}

export function mergeOptionalBoolean(
  current: boolean | undefined,
  next: boolean | undefined,
): boolean | undefined {
  if (current === true || next === true) return true;
  if (current === false || next === false) return false;
  return undefined;
}

export function mergeEquipContexts(
  current: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>();
  for (const value of current || []) {
    if (isDisplayableEquipContext(value)) merged.add(value.trim());
  }
  for (const value of next || []) {
    if (isDisplayableEquipContext(value)) merged.add(value.trim());
  }
  const result = [...merged].slice(0, 6);
  return result.length > 0 ? result : undefined;
}
