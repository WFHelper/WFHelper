import type { ItemDbLookup } from "../types/ipc.js";

/** Base-frame identity: "Nyx Prime Neuroptics Blueprint" and "Nyx" share a family. */
function familyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+blueprint$/, "")
    .replace(/\s+(chassis|systems|neuroptics)$/, "")
    .replace(/\s+(prime|umbra)$/, "")
    .trim();
}

/** Families the player has fed to the Helminth (InfestedFoundry.ConsumedSuits). */
export function buildSubsumedFamilySet(inventoryData: unknown, itemDb: ItemDbLookup): Set<string> {
  const set = new Set<string>();
  const consumed = (
    inventoryData as {
      InfestedFoundry?: { ConsumedSuits?: Array<{ s?: string; ItemType?: string }> };
    } | null
  )?.InfestedFoundry?.ConsumedSuits;
  if (!Array.isArray(consumed)) return set;
  for (const entry of consumed) {
    const un = typeof entry?.s === "string" ? entry.s : entry?.ItemType || "";
    if (!un) continue;
    const name = itemDb[un]?.name || un.split("/").pop() || "";
    if (name) set.add(familyName(String(name)));
  }
  return set;
}

export function isFrameSubsumed(name: string, families: Set<string>): boolean {
  if (families.size === 0) return false;
  return families.has(familyName(name));
}
