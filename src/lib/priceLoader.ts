import { fetchPriceByName } from "./wfm/wfmPrice.js";
import { send } from "./ipc.js";

interface PriceState {
  text: string;
  slug: string | null;
}

/** WFM price for an item/component - { text, slug }. */
export async function loadItemPrice(
  name: string,
  wfmItems: Record<string, { url_name: string }>,
  isTradable: boolean,
): Promise<PriceState> {
  if (!isTradable) {
    return { text: "Item is not tradable.", slug: null };
  }
  try {
    const result = await fetchPriceByName(name, wfmItems, { priority: "high" });
    if (result?.median != null) {
      return { text: `~${result.median} platinum (48h median)`, slug: result.slug };
    }
    const mapping = (wfmItems || {})[name?.toLowerCase()];
    if (mapping) {
      return { text: "No recent price data.", slug: mapping.url_name };
    }
    return { text: "No listing found.", slug: null };
  } catch {
    return { text: "Failed to load price data.", slug: null };
  }
}

/** Open an item on warframe.market by slug. */
export function openOnWfm(slug: string | null): void {
  if (slug) send("open-external", `https://warframe.market/items/${slug}`);
}
