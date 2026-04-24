import type { ComponentInfo, DropInfo, ItemDbEntry, ParsedItem } from "../types/inventory.js";
import { enrichComponents } from "../stores/data.js";

export function buildParsedItemFromDb(
  uniqueName: string,
  dbEntry: ItemDbEntry,
  ownership: Map<string, number>,
  options: { extraDrops?: DropInfo[] } = {},
): ParsedItem {
  const drops = [...(dbEntry.drops || []), ...(options.extraDrops || [])];
  return {
    name: dbEntry.name || "Unknown",
    internalName: uniqueName,
    category: dbEntry.category || "",
    categoryLabel: dbEntry.category || "",
    rank: 0,
    maxRank: 0,
    imageUrl: dbEntry.imageUrl || null,
    isPrime: dbEntry.isPrime || false,
    masteryReq: dbEntry.masteryReq || 0,
    vaulted: dbEntry.vaulted || false,
    tradable: dbEntry.tradable || false,
    description: dbEntry.description || "",
    components: enrichComponents((dbEntry.components || []) as ComponentInfo[], ownership),
    drops,
    wikiaUrl: dbEntry.wikiaUrl || null,
    uniqueName,
  };
}
