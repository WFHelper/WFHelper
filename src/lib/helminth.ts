import type { ItemDbLookup } from "../types/ipc.js";

/** "Nyx Prime Neuroptics Blueprint" -> "nyx prime" (part suffixes dropped). */
function baseFrameName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+blueprint$/, "")
    .replace(/\s+(chassis|systems|neuroptics)$/, "")
    .trim();
}

/** Base-frame identity: "Nyx Prime Neuroptics Blueprint" and "Nyx" share a family. */
function familyName(name: string): string {
  return baseFrameName(name)
    .replace(/\s+(prime|umbra|dex)$/, "")
    .trim();
}

/** Only base frames can be fed to the Helminth; Prime/Umbra/Dex variants never can. */
export function isSubsumableFrame(name: string): boolean {
  return !/\s(prime|umbra|dex)$/.test(baseFrameName(name));
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
