import { isRankedGroup, toFinitePositiveInt } from "../../config/shared/numeric.js";
import { normalizeMarketName, toMarketSlug } from "./marketNaming.js";
import { type InventoryBaseItem } from "./inventoryMarket.js";
import type { InventoryGroup, ParsedItem } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { WfmOrder } from "../types/market.js";

type MarketOrderInventoryItem = InventoryBaseItem & { sourceOrderId: string };

function parsedItemForOrder(order: WfmOrder, parsedItems: ParsedItem[]): ParsedItem | null {
  const orderName = normalizeMarketName(order.itemName);
  const orderSlug = toMarketSlug(order.itemUrlName || order.itemName);
  return (
    parsedItems.find((item) => normalizeMarketName(item.name) === orderName) ||
    parsedItems.find((item) => toMarketSlug(item.name) === orderSlug) ||
    null
  );
}

function lookupMaxRank(order: WfmOrder, wfmItems: WfmItemsLookup): number | null {
  const slug = toMarketSlug(order.itemUrlName || order.itemName);
  for (const item of Object.values(wfmItems)) {
    if (toMarketSlug(item.url_name) !== slug) continue;
    return toFinitePositiveInt(item.maxRank);
  }
  return null;
}

function inventoryGroupForOrder(order: WfmOrder, parsedItem: ParsedItem | null): InventoryGroup {
  if (parsedItem?.inventoryGroup) return parsedItem.inventoryGroup;
  if (parsedItem?.categoryLabel?.toLowerCase().includes("arcane")) return "arcanes";
  if (parsedItem?.categoryLabel?.toLowerCase().includes("mod")) return "mods";
  if (order.modRank != null) return "mods";
  return "all_parts";
}

function ownedCountForOrder(parsedItem: ParsedItem | null): number {
  if (!parsedItem) return 0;
  if (typeof parsedItem.amount === "number") return parsedItem.amount;
  return parsedItem.currentlyOwned ? 1 : 0;
}

export function buildMarketOrderInventoryItem(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
): MarketOrderInventoryItem {
  const parsedItem = parsedItemForOrder(order, parsedItems);
  const inventoryGroup = inventoryGroupForOrder(order, parsedItem);
  const isRankedListing = isRankedGroup(inventoryGroup);
  const rank = isRankedListing ? Math.max(0, Math.floor(order.modRank ?? 0)) : 0;
  const maxRank =
    toFinitePositiveInt(parsedItem?.maxRank) ??
    lookupMaxRank(order, wfmItems) ??
    (inventoryGroup === "mods" ? 10 : inventoryGroup === "arcanes" ? 5 : 0);
  const marketSlug = toMarketSlug(order.itemUrlName || order.itemName);
  const ownedCount = ownedCountForOrder(parsedItem);

  return {
    ...(parsedItem ?? {}),
    sourceOrderId: order.id,
    name: order.itemName,
    internalName: `market-order:${marketSlug || order.id}:r${rank}`,
    category: parsedItem?.category ?? (inventoryGroup === "mods" ? "Mods" : "Market"),
    categoryLabel: parsedItem?.categoryLabel ?? (inventoryGroup === "mods" ? "Mod" : "Market Item"),
    rank,
    maxRank,
    imageUrl: parsedItem?.imageUrl ?? order.itemThumb,
    isPrime: parsedItem?.isPrime ?? /\bprime\b/i.test(order.itemName),
    masteryReq: parsedItem?.masteryReq ?? 0,
    vaulted: parsedItem?.vaulted ?? false,
    tradable: true,
    description: parsedItem?.description ?? "",
    components: parsedItem?.components ?? [],
    drops: parsedItem?.drops ?? [],
    wikiaUrl: parsedItem?.wikiaUrl ?? null,
    inventoryGroup,
    partType: parsedItem?.partType ?? (/\bprime\b/i.test(order.itemName) ? "prime" : "normal"),
    amount: ownedCount,
    favorite: parsedItem?.favorite ?? false,
    equipped: parsedItem?.equipped ?? false,
    orderPlaced: true,
    completeSets: parsedItem?.completeSets ?? null,
    marketSlug: marketSlug || null,
    marketThumb: order.itemThumb ?? null,
  };
}
