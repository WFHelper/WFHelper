import { ownedCountForMarketOrder } from "../marketOrderInventory.js";
import type { ParsedItem } from "../../types/inventory.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import type { WfmOrder } from "../../types/market.js";

/** Owned count for one WFM item slug, computed renderer-side and pushed to the
 *  alert engine on rule save. Reuses the market order join so renamed listings
 *  still resolve through the catalog gameRef, never the display name. */
export function ownedCountForAlertItem(
  itemUrlName: string,
  itemName: string,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
): number {
  const probe: WfmOrder = {
    id: `alert-probe:${itemUrlName}`,
    orderType: "sell",
    platinum: 0,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: null,
    itemName,
    itemUrlName,
    itemThumb: null,
  };
  return ownedCountForMarketOrder(probe, parsedItems, wfmItems);
}
