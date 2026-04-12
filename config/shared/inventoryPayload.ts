const DEFAULT_MAX_UNWRAP_DEPTH = 4;
const MAX_SAFE_UNWRAP_DEPTH = 12;

const INVENTORY_ARRAY_KEYS: readonly string[] = Object.freeze([
  "Suits",
  "RawUpgrades",
  "Upgrades",
  "Arcanes",
  "LevelKeys",
  "MiscItems",
]);

const ENVELOPE_KEYS: readonly string[] = Object.freeze([
  "InventoryJson",
  "inventoryJson",
  "inventory_json",
  "payload",
  "data",
]);

export function hasInventoryShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return INVENTORY_ARRAY_KEYS.some((key) => Array.isArray(record[key]));
}

function normalizeMaxDepth(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_UNWRAP_DEPTH;
  const rounded = Math.floor(n);
  if (rounded < 1) return DEFAULT_MAX_UNWRAP_DEPTH;
  return Math.min(rounded, MAX_SAFE_UNWRAP_DEPTH);
}

function firstEnvelopeValue(record: Record<string, unknown>): unknown {
  for (const key of ENVELOPE_KEYS) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

export interface UnwrapInventoryOptions {
  returnInputOnFailure?: boolean;
  onParseError?: (error: unknown) => void;
  maxDepth?: number;
}

export function unwrapInventoryPayload(
  value: unknown,
  options: UnwrapInventoryOptions = {},
): unknown {
  let current = value;
  const returnInputOnFailure = Boolean(options.returnInputOnFailure);
  const onParseError = typeof options.onParseError === "function" ? options.onParseError : null;
  const maxDepth = normalizeMaxDepth(options.maxDepth);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (hasInventoryShape(current)) return current;
    if (!current || typeof current !== "object") {
      return returnInputOnFailure ? value : current;
    }

    const next = firstEnvelopeValue(current as Record<string, unknown>);

    if (typeof next === "string") {
      try {
        current = JSON.parse(next);
        continue;
      } catch (err) {
        if (onParseError) onParseError(err);
        return returnInputOnFailure ? value : current;
      }
    }

    if (next && typeof next === "object") {
      current = next;
      continue;
    }

    return current;
  }

  return current;
}

export const __test__ = {
  DEFAULT_MAX_UNWRAP_DEPTH,
  MAX_SAFE_UNWRAP_DEPTH,
  INVENTORY_ARRAY_KEYS,
  ENVELOPE_KEYS,
  normalizeMaxDepth,
  firstEnvelopeValue,
};
