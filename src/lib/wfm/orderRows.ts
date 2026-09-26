import type { MessageKey, Translator } from "../i18n.js";
import type { OrderBookEntry } from "./orderBook.js";

export type SellerStatusFilter = "all" | "onsite" | "ingame";

export function matchesSellerStatus(status: string | null, filter: SellerStatusFilter): boolean {
  if (filter === "ingame") return status === "ingame";
  if (filter === "onsite") return status === "online";
  return true;
}

export function sellerStatusLabelKey(status: string | null): MessageKey {
  if (status === "ingame") return "browse.status.ingame";
  if (status === "online") return "common.online";
  if (status === "invisible") return "common.invisible";
  return "common.offline";
}

/** Whisper that answers `entry`: a sell order gets a buy message and back. */
export function orderWhisper(
  t: Translator,
  side: "sell" | "buy",
  entry: OrderBookEntry,
  itemText: string,
): string {
  if (entry.perTrade > 1) {
    return t(side === "sell" ? "common.whisperBuyBulk" : "common.whisperSellBulk", {
      user: entry.userName,
      item: itemText,
      count: entry.perTrade,
      platinum: entry.platinum,
    });
  }
  return t(side === "sell" ? "common.whisperBuy" : "common.whisperSell", {
    user: entry.userName,
    item: itemText,
    platinum: entry.platinum,
  });
}
