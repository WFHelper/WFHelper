import type { RawInventoryData } from "../types/inventory.js";

export function hasInventoryShape(data: unknown): data is RawInventoryData {
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  return Boolean(
    Array.isArray(record.Suits) ||
    Array.isArray(record.Upgrades) ||
    Array.isArray(record.Arcanes) ||
    Array.isArray(record.LevelKeys) ||
    Array.isArray(record.MiscItems),
  );
}

export function unwrapInventoryPayload(data: RawInventoryData): RawInventoryData {
  let current: unknown = data;

  for (let i = 0; i < 4; i += 1) {
    if (hasInventoryShape(current)) return current;
    if (!current || typeof current !== "object") return data;

    const record = current as Record<string, unknown>;
    const next =
      record.InventoryJson ??
      record.inventoryJson ??
      record.inventory_json ??
      record.payload ??
      record.data;

    if (typeof next === "string") {
      try {
        current = JSON.parse(next) as unknown;
        continue;
      } catch {
        return data;
      }
    }

    if (next && typeof next === "object") {
      current = next;
      continue;
    }

    return (current as RawInventoryData) || data;
  }

  return (current as RawInventoryData) || data;
}
