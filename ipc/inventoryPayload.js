"use strict";

function hasInventoryShape(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    Array.isArray(value.Suits) ||
    Array.isArray(value.Upgrades) ||
    Array.isArray(value.Arcanes) ||
    Array.isArray(value.LevelKeys) ||
    Array.isArray(value.MiscItems),
  );
}

function unwrapInventoryPayload(value, options = {}) {
  let current = value;
  const onParseError =
    options && typeof options === "object" && typeof options.onParseError === "function"
      ? options.onParseError
      : null;

  for (let i = 0; i < 4; i += 1) {
    if (hasInventoryShape(current)) return current;
    if (!current || typeof current !== "object") return current;

    const next =
      current.InventoryJson ??
      current.inventoryJson ??
      current.inventory_json ??
      current.payload ??
      current.data;

    if (typeof next === "string") {
      try {
        current = JSON.parse(next);
        continue;
      } catch (err) {
        if (onParseError) onParseError(err);
        return current;
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

module.exports = {
  hasInventoryShape,
  unwrapInventoryPayload,
};
