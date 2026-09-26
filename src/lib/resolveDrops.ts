import { invoke } from "./ipc.js";
import { ownedRelicQualities, relicGroupForDisplayName } from "./relic/relicInventory.js";
import type { DropInfo } from "../types/inventory.js";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

interface DropsSource {
  drops?: DropInfo[];
  uniqueName?: string;
}

/** Drop sources for an item/component; itemDb fallback when its own drops are empty. */
export function resolveDrops(
  item: DropsSource | null | undefined,
  itemDb: Record<string, { drops?: DropInfo[] }>,
): DropInfo[] {
  if (!item) return [];
  if (item.drops && item.drops.length > 0) return item.drops;
  if (item.uniqueName) {
    const dbEntry = itemDb[item.uniqueName];
    if (dbEntry?.drops && dbEntry.drops.length > 0) return dbEntry.drops;
  }
  return [];
}

/** English name to look up in the drop tables, or null while the item data lists a source. */
export function dropTableQuery(
  item: (DropsSource & { name?: string }) | null | undefined,
  itemDb: Record<string, { name?: string; drops?: DropInfo[] }>,
): string | null {
  if (!item || resolveDrops(item, itemDb).length > 0) return null;
  const name = (item.uniqueName ? itemDb[item.uniqueName]?.name : undefined) || item.name || "";
  return name.trim() || null;
}

const tableDropsByName = new Map<string, Promise<DropInfo[]>>();

/** What the drop tables list under that name; rows are kept, a failure or no rows asked again later. */
export function dropTableSources(name: string): Promise<DropInfo[]> {
  const key = name.trim().toLowerCase();
  const cached = tableDropsByName.get(key);
  if (cached) return cached;
  const pending = Promise.resolve()
    .then(() => invoke("dropSourcesForItem", name.trim()))
    .then(
      (rows) => {
        // Main answers a failed drop download with no rows too.
        if (rows.length === 0) tableDropsByName.delete(key);
        return rows.map((row) => ({
          location: row.place,
          type: row.item,
          chance: row.chance ?? 0,
          rarity: row.rarity,
        }));
      },
      () => {
        tableDropsByName.delete(key);
        return [];
      },
    );
  tableDropsByName.set(key, pending);
  return pending;
}

/** Loads drop table rows but hands on only the answer for the name asked last. */
export function latestDropTableSources(
  apply: (query: string, drops: DropInfo[]) => void,
): (query: string) => Promise<void> {
  let latest = "";
  return async (query) => {
    latest = query;
    const drops = await dropTableSources(query);
    if (query === latest) apply(query, drops);
  };
}

/** Relics the player holds in any refinement move to the front; both parts keep their order. */
export function ownedRelicDropsFirst(
  drops: readonly DropInfo[],
  relicDb: RelicDatabase | null,
  ownedCounts: OwnedCounts,
): DropInfo[] {
  const owned: DropInfo[] = [];
  const rest: DropInfo[] = [];
  for (const drop of drops) {
    const group = relicGroupForDisplayName(relicDb, drop.location);
    const held = group !== null && ownedRelicQualities(ownedCounts, group.key).length > 0;
    (held ? owned : rest).push(drop);
  }
  return [...owned, ...rest];
}
