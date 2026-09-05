import { componentUniqueNameAliases } from "../../config/shared/componentNames.js";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../config/shared/foundryPending.js";
import { buildClaimResolver, type RecipeClaim } from "./recipeClaims.js";
import type { ItemDbEntry, MasteryData, MasteryStatus } from "../types/inventory.js";

/** Built gear lives in its own inventory collections, not MiscItems, and a built
 *  weapon can be an ingredient (Bronco Prime -> Akbronco Prime). */
const BUILT_GEAR_COLLECTIONS = [
  "Suits",
  "LongGuns",
  "Pistols",
  "Melee",
  "SpecialItems",
  "SentinelWeapons",
  "Sentinels",
  "SpaceGuns",
  "SpaceMelee",
  "SpaceSuits",
  "MechSuits",
  "Hoverboards",
  "OperatorAmps",
  "KubrowPets",
  "MoaPets",
] as const;

interface RowLike {
  name: string;
  internalName?: string;
  amount?: number | null;
  parentMastered?: boolean;
  spare?: boolean;
}

interface PartMasteryFlags {
  parentMastered?: boolean;
  spare?: boolean;
  /** Copies free to sell once every unfinished recipe is served. */
  sellable?: number;
  reserved?: number;
  claims?: RecipeClaim[];
}

type PartMasteryResolver = (row: RowLike) => PartMasteryFlags;

interface PartMasteryOptions {
  /** Keep a copy of gear another recipe consumes, so both variants survive. */
  keepVariants?: boolean;
}

function dbEntryFor(
  itemDb: Record<string, ItemDbEntry>,
  key: string | undefined,
): { uniqueName: string; entry: ItemDbEntry } | null {
  if (!key) return null;
  const candidates = [...componentUniqueNameAliases(key), key.replace(/Blueprint$/i, "")];
  for (const candidate of candidates) {
    const entry = itemDb[candidate];
    if (entry) return { uniqueName: candidate, entry };
  }
  return null;
}

/** Owned copies per uniqueName across parts, blueprints and built gear. */
function buildOwnedCounts(
  inventoryData: unknown,
  itemDb: Record<string, ItemDbEntry> = {},
): Map<string, number> {
  const inventory = (inventoryData ?? {}) as Record<string, unknown>;
  const usable = withoutFoundryPending(
    inventory,
    (uniqueName) => itemDb[uniqueName]?.reusableBlueprint === true,
  ) as Record<string, unknown>;
  const owned = aggregateComponentOwnership(usable.MiscItems, usable.Recipes);

  for (const collection of BUILT_GEAR_COLLECTIONS) {
    const slice = usable[collection];
    if (!Array.isArray(slice)) continue;
    for (const entry of slice) {
      const itemType = (entry as { ItemType?: unknown })?.ItemType;
      if (typeof itemType !== "string" || !itemType) continue;
      // Built gear is one row per copy; ItemCount is absent or 1.
      owned.set(itemType, (owned.get(itemType) ?? 0) + 1);
    }
  }
  return owned;
}

/** Per-row mastery and sell-safety flags. A part stays reserved while any recipe
 * above it is unfinished, however many levels up that recipe sits. Unset flags
 * mean nothing masterable needs the row, and filters skip it. */
export function buildPartMasteryResolver(
  itemDb: Record<string, ItemDbEntry>,
  mastery: MasteryData | null,
  inventoryData?: unknown,
  options: PartMasteryOptions = {},
): PartMasteryResolver {
  const items = mastery?.items ?? [];
  if (items.length === 0) return () => ({});

  const statusByUnique = new Map<string, MasteryStatus>();
  const statusByName = new Map<string, MasteryStatus>();
  for (const item of items) {
    if (!item.status) continue;
    if (item.uniqueName) statusByUnique.set(item.uniqueName, item.status);
    statusByName.set(item.name.toLowerCase(), item.status);
  }

  const nameIndex = new Map<string, string>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    const key = entry.name?.toLowerCase();
    if (key && !nameIndex.has(key)) nameIndex.set(key, uniqueName);
  }

  const statusOf = (uniqueName?: string, name?: string): MasteryStatus | undefined =>
    (uniqueName ? statusByUnique.get(uniqueName) : undefined) ??
    (name ? statusByName.get(name.toLowerCase()) : undefined);

  const ownedCounts = buildOwnedCounts(inventoryData, itemDb);
  const statusFor = (uniqueName: string): MasteryStatus | undefined =>
    statusOf(uniqueName, itemDb[uniqueName]?.name);
  const claimResolver = buildClaimResolver(
    itemDb,
    statusFor,
    (uniqueName) => {
      // Levelled or mastered gear is in hand even when the raw collections are
      // absent, so the catalogue status is a floor under the counted copies.
      const status = statusFor(uniqueName);
      const held = status === "mastered" || status === "progress" ? 1 : 0;
      return Math.max(ownedCounts.get(uniqueName) ?? 0, held);
    },
    { keepVariants: options.keepVariants === true },
  );

  const masteredFlag = (status: MasteryStatus | undefined): PartMasteryFlags =>
    status ? { parentMastered: status === "mastered" } : {};

  return (row) => {
    const setBase = /\sSet$/i.test(row.name) ? row.name.replace(/\s+Set$/i, "") : null;
    if (setBase) return masteredFlag(statusOf(undefined, setBase));

    const resolved =
      dbEntryFor(itemDb, row.internalName) ??
      dbEntryFor(itemDb, nameIndex.get(row.name.toLowerCase()));
    if (resolved?.entry.isBuildComponent && resolved.entry.componentOf) {
      const owned = typeof row.amount === "number" ? row.amount : 0;
      const claim = claimResolver(resolved.uniqueName, owned);
      const status = statusOf(resolved.entry.componentOf, itemDb[resolved.entry.componentOf]?.name);
      if (!status && claim.claims.length === 0) return {};
      return {
        ...(status ? { parentMastered: status === "mastered" } : {}),
        reserved: claim.reserved,
        claims: claim.claims,
        ...(typeof row.amount === "number"
          ? { spare: claim.sellable > 0, sellable: claim.sellable }
          : {}),
      };
    }
    return masteredFlag(statusOf(resolved?.uniqueName ?? row.internalName, row.name));
  };
}

/** Takes a prebuilt resolver: it indexes the whole item database, so callers
 * keep one per itemDb/mastery pair instead of rebuilding it per row list. */
export function attachPartMasteryFlags<T extends RowLike>(
  rows: T[],
  resolve: PartMasteryResolver,
): T[] {
  return rows.map((row) => {
    const flags = resolve(row);
    return Object.keys(flags).length === 0 ? row : { ...row, ...flags };
  });
}
