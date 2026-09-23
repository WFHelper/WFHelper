import { buildParsedItemFromDb } from "../parsedItemFromDb.js";
import { QUALITY_MODES } from "./relicConstants.js";
import { relicGroupForUniqueName } from "./relicInventory.js";
import type { ItemDbEntry, ParsedItem } from "../../types/inventory.js";
import type { RelicDatabase, RelicGroup, RelicQuality } from "../../types/relics.js";

export type RelicView = "simple" | "detailed";
/** "auto" keeps the popup each tab opens until the switch has been used once. */
export type RelicViewPreference = RelicView | "auto";

export const RELIC_VIEW_PREFERENCES: readonly RelicViewPreference[] = [
  "auto",
  "simple",
  "detailed",
];

/** A relic DE ships before @wfcd lists its drops has nothing to break down. */
function relicHasRewards(group: RelicGroup): boolean {
  return QUALITY_MODES.some((quality) => (group.qualities[quality]?.rewards.length ?? 0) > 0);
}

function relicItemKey(item: ParsedItem): string {
  return item.uniqueName || item.internalName || "";
}

/** The breakdown for an item popup's relic, or null when there is none to show. */
export function detailedRelicFor(
  relicDb: RelicDatabase | null,
  uniqueName: string,
): RelicGroup | null {
  const group = uniqueName ? relicGroupForUniqueName(relicDb, uniqueName) : null;
  return group && relicHasRewards(group) ? group : null;
}

/** The item popup for a relic: the preferred refinement, then the game's tier order. */
export function simpleRelicFor(
  group: RelicGroup,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  preferred?: RelicQuality,
): ParsedItem | null {
  const order = preferred ? [preferred, ...QUALITY_MODES] : QUALITY_MODES;
  for (const quality of order) {
    const uniqueName = group.qualities[quality]?.uniqueName;
    const entry = uniqueName ? itemDb[uniqueName] : undefined;
    if (uniqueName && entry) return buildParsedItemFromDb(uniqueName, entry, ownership);
  }
  return null;
}

/** Only a remembered "detailed" turns an item popup into the breakdown. */
export function redirectItemToRelic(
  preference: RelicViewPreference,
  item: ParsedItem,
  relicDb: RelicDatabase | null,
): RelicGroup | null {
  return preference === "detailed" ? detailedRelicFor(relicDb, relicItemKey(item)) : null;
}

/** A remembered "simple", or "detailed" with no rewards to show, opens the item popup. */
export function redirectRelicToItem(
  preference: RelicViewPreference,
  group: RelicGroup,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): ParsedItem | null {
  if (preference === "auto") return null;
  if (preference === "detailed" && relicHasRewards(group)) return null;
  return simpleRelicFor(group, itemDb, ownership);
}
