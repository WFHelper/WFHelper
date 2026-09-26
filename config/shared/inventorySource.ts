/** Where inventory data comes from. Only "helper" acquires data on its own. */
export type InventorySource = "helper" | "manual" | "aleca" | "none";

export const DEFAULT_INVENTORY_SOURCE: InventorySource = "helper";

export type InventoryExportError = "noInventory" | "noWindow" | "writeFailed";

/** Older builds persisted "json" for both helper output and manual imports;
 *  they ran the helper regardless, so that state maps onto "helper". */
export function normalizeInventorySource(raw: unknown): InventorySource {
  if (raw === "helper" || raw === "manual" || raw === "aleca" || raw === "none") return raw;
  return DEFAULT_INVENTORY_SOURCE;
}
