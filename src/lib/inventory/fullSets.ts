import { componentUniqueNameAliases } from "../../../config/shared/componentNames.js";
import type { ItemDbEntry, ParsedItem } from "../../types/inventory.js";
import {
  type ResolvedItem,
  resolveItem,
  isAyatanLikeItem,
  isSceneLikeItem,
  isRelicLikeItem,
} from "./itemClassification.js";

// Special non-prime weapons (Ghoulsaw, Orvius, ...) get every component flagged
// tradable:false by @wfcd, even the parts that the set is actually sold as. Their
// real parts always live under .../Recipes/Weapons/WeaponParts/, so treat those as
// set parts regardless of the flag. This deliberately leaves out a non-tradeable
// standalone main blueprint (not part of the WFM set) and build resources.
function isWeaponPart(uniqueName: string): boolean {
  return /\/Recipes\/Weapons\/WeaponParts?\//i.test(uniqueName);
}

// A set component can be owned under a different name than the set lists it:
//   - warframe parts: set says ...Component, inventory holds ...Blueprint
//   - weapon parts:   set says ...Blade,     inventory holds ...BladeBlueprint
// Try every spelling and take the largest; they're the same part, not separate
// piles, so max (not sum) is the real owned count.
function ownedAcrossAliases(uniqueName: string, ownedCounts: Map<string, number>): number {
  if (!uniqueName) return 0;
  const candidates = componentUniqueNameAliases(uniqueName);
  if (!/Blueprint$/i.test(uniqueName)) candidates.push(`${uniqueName}Blueprint`);
  let owned = 0;
  for (const key of candidates) owned = Math.max(owned, ownedCounts.get(key) || 0);
  return owned;
}

function isEligibleFullSetRoot(
  uniqueName: string,
  dbEntry: ItemDbEntry,
  resolved: ResolvedItem,
  tradableComponentCount: number,
): boolean {
  if (tradableComponentCount < 2) return false;
  if (isAyatanLikeItem(uniqueName, dbEntry, resolved)) return false;
  if (isSceneLikeItem(uniqueName, dbEntry, resolved)) return false;
  if (isRelicLikeItem(uniqueName, dbEntry, resolved)) return false;

  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (
    type.includes("captura") ||
    type.includes("ayatan") ||
    type.includes("resource") ||
    type.includes("booster")
  ) {
    return false;
  }

  if (
    name.includes("ayatan") ||
    name.endsWith(" scene") ||
    name.includes("booster") ||
    name.includes("quest")
  ) {
    return false;
  }

  if (resolved.isPrime === true || /\bprime\b/i.test(resolved.name)) return true;

  const category = String(dbEntry.category || "").toLowerCase();

  if (
    /(warframe|rifle|shotgun|sniper|bow|pistol|melee|companion|sentinel|archwing|necramech|orbiter|landing craft)/.test(
      type,
    )
  ) {
    return true;
  }

  return /(warframe|weapon|primary|secondary|melee|sentinel|pet|companion|archwing|necramech)/.test(
    category,
  );
}

export function buildFullSetItems(
  itemDb: Record<string, ItemDbEntry>,
  ownedCounts: Map<string, number>,
): ParsedItem[] {
  const setItems: ParsedItem[] = [];

  for (const [uniqueName, dbEntry] of Object.entries(itemDb)) {
    const components = Array.isArray(dbEntry.components) ? dbEntry.components : [];
    // Don't gate on the root's `tradable` flag: assembled Warframes are
    // tradable:false even though their parts and the set are tradable. The
    // tradable-component count below + isEligibleFullSetRoot handle eligibility.
    if (components.length === 0) continue;

    const resolved = resolveItem(uniqueName, itemDb);

    const setComponents = components.filter(
      (component) =>
        component.uniqueName &&
        (component.tradable !== false || isWeaponPart(component.uniqueName)),
    );
    if (setComponents.length === 0) continue;

    if (!isEligibleFullSetRoot(uniqueName, dbEntry, resolved, setComponents.length)) {
      continue;
    }

    let completeSets = Number.POSITIVE_INFINITY;

    const hydratedComponents = setComponents.map((component) => {
      const unique = component.uniqueName || "";
      const required =
        typeof component.itemCount === "number" && component.itemCount > 0
          ? component.itemCount
          : 1;
      const ownedCount = ownedAcrossAliases(unique, ownedCounts);
      completeSets = Math.min(completeSets, Math.floor(ownedCount / required));

      return {
        ...component,
        ownedCount,
        owned: ownedCount >= required,
      };
    });

    if (!Number.isFinite(completeSets)) completeSets = 0;
    // Only surface sets the user can actually sell - at least one full set's
    // worth of spare components. Partial progress lives in the parts tab.
    if (completeSets < 1) continue;

    const setName = resolved.name.endsWith(" Set") ? resolved.name : `${resolved.name} Set`;
    const isPrime = resolved.isPrime === true || /\bPrime\b/.test(resolved.name);

    setItems.push({
      name: setName,
      internalName: `${uniqueName}#set`,
      category: "full_sets",
      categoryLabel: "Full Set",
      rank: 0,
      maxRank: 1,
      imageUrl: resolved.imageUrl ?? null,
      isPrime,
      masteryReq: resolved.masteryReq ?? 0,
      vaulted: resolved.vaulted ?? false,
      tradable: true,
      description: typeof dbEntry.description === "string" ? dbEntry.description : "",
      components: hydratedComponents,
      drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
      wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      amount: completeSets,
      completeSets,
      partType: isPrime ? "prime" : "normal",
      inventoryGroup: "full_sets",
      leveledUp: false,
      keywords: ["set", "full set", resolved.name.toLowerCase()],
    });
  }

  return setItems;
}
