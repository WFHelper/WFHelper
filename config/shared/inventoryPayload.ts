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

interface UnwrapInventoryOptions {
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

/** The inventory's own JSON text inside a payload, or null when it sits under an
 *  object envelope. Strings survive JSON.parse unchanged, so unlike the parsed
 *  value this keeps integers beyond 2^53 exact. */
export function unwrapInventoryText(text: string): string | null {
  let current = text;
  for (let depth = 0; depth < MAX_SAFE_UNWRAP_DEPTH; depth += 1) {
    const value: unknown = JSON.parse(current);
    if (hasInventoryShape(value)) return current;
    if (!value || typeof value !== "object") return null;
    const next = firstEnvelopeValue(value as Record<string, unknown>);
    if (typeof next !== "string") return null;
    current = next;
  }
  return null;
}
