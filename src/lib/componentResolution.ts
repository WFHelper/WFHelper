import { componentUniqueNameAliases } from "../../config/shared/componentNames.js";
import { resolveDrops } from "./resolveDrops.js";
import type { ComponentInfo, DropInfo, ItemDbEntry, ParsedItem } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";

interface ResolvedComponentPanel {
  comp: ComponentInfo;
  parentName: string;
}

interface PriceLookupPlan {
  name: string;
  isTradable: boolean;
  fallbackName?: string;
  fallbackTradable?: boolean;
}

export function buildItemNameIndex(itemDb: Record<string, ItemDbEntry>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    if (entry.name) map.set(entry.name, uniqueName);
  }
  return map;
}

function withOwnership(comp: ComponentInfo, ownership: Map<string, number>): ComponentInfo {
  const count = comp.uniqueName ? ownership.get(comp.uniqueName) || 0 : 0;
  return { ...comp, ownedCount: count, owned: count >= (comp.itemCount || 1) };
}

function fallbackComponent(
  uniqueName: string,
  db: ItemDbEntry,
  ownership: Map<string, number>,
): ComponentInfo {
  return withOwnership(
    {
      name: db.name || "Unknown Component",
      uniqueName,
      ...(db.tradable != null ? { tradable: db.tradable } : {}),
      itemCount: 1,
      drops: db.drops || [],
    },
    ownership,
  );
}

function resolveComponentByUniqueName(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): ResolvedComponentPanel | null {
  const db = itemDb[uniqueName];
  if (!db) return null;

  if (db.isBuildComponent && db.componentOf) {
    const parent = itemDb[db.componentOf];
    const enriched = (parent?.components || []).map((comp) => withOwnership(comp, ownership));
    const aliases = componentUniqueNameAliases(uniqueName);
    const parentComp = enriched.find((comp) =>
      Boolean(comp.uniqueName && aliases.includes(comp.uniqueName)),
    );
    if (parentComp) {
      return { comp: parentComp, parentName: parent?.name || "" };
    }
  }

  return { comp: fallbackComponent(uniqueName, db, ownership), parentName: "" };
}

export function resolveComponentByName(
  name: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  nameIndex: Map<string, string> = buildItemNameIndex(itemDb),
): ResolvedComponentPanel | null {
  const uniqueName = nameIndex.get(name);
  return uniqueName ? resolveComponentByUniqueName(uniqueName, itemDb, ownership) : null;
}

export function resolveComponentDrops(
  comp: ComponentInfo | null | undefined,
  itemDb: Record<string, ItemDbEntry>,
): DropInfo[] {
  return resolveDrops(comp, itemDb);
}

export function resolveComponentLocation(dbEntry: ItemDbEntry | null | undefined): string {
  const description = dbEntry?.description || "";
  const locMatch = description.match(/Location:\s*(.+)/i);
  return locMatch ? locMatch[0] : "";
}

export function resolveComponentWikiFallback(
  comp: ComponentInfo,
  parentName: string,
  dbEntry: ItemDbEntry | null | undefined,
): string {
  if (dbEntry?.isBuildComponent && parentName) return parentName;
  return dbEntry?.name || comp.name;
}

export function resolveComponentPriceLookup(
  comp: ComponentInfo,
  parentName: string,
  dbEntry: ItemDbEntry | null | undefined,
  lookup: WfmItemsLookup,
): PriceLookupPlan {
  const fullName = parentName ? `${parentName} ${comp.name}` : comp.name;
  const nameKey = fullName?.toLowerCase() || "";
  const directMatch = lookup[nameKey] || lookup[comp.name?.toLowerCase() || ""];
  const isTradable = Boolean(comp.tradable || directMatch);
  const shouldTryBlueprint = Boolean(
    dbEntry?.isBuildComponent && parentName && !nameKey.endsWith(" blueprint") && !directMatch,
  );

  if (shouldTryBlueprint) {
    return {
      name: `${fullName} Blueprint`,
      isTradable: true,
      fallbackName: fullName,
      fallbackTradable: isTradable,
    };
  }

  return { name: fullName, isTradable };
}

export function resolveItemPriceLookup(item: ParsedItem, lookup: WfmItemsLookup): PriceLookupPlan {
  const name = item.name;
  const nameKey = name.toLowerCase();
  const setName = `${name} Set`;
  const isTradable = Boolean(
    item.tradable || item.isPrime || lookup[nameKey] || lookup[setName.toLowerCase()],
  );
  return { name, isTradable };
}
