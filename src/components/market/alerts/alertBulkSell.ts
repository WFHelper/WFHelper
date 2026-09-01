import { readStorage, writeStorage } from "../../../lib/persistence.js";
import { toMarketSlug } from "../../../lib/marketNaming.js";
import { resolveQueueSlug, selectionKeyFor } from "../../../lib/tradeWorkbench/queueModel.js";
import {
  bulkSellOpen,
  selectKeys,
  type SavedSelection,
} from "../../../stores/inventorySelection.js";
import type { MarketAlertRule } from "../../../../config/shared/marketAlertTypes.js";
import type { ParsedItem } from "../../../types/inventory.js";
import type { WfmItemsLookup } from "../../../types/ipc.js";

// Device-local UI state, deliberately outside the rule schema: an exported rule
// must not carry the name of a selection only this machine has.
const LINKS_KEY = "wf_market_alert_sell_links";
/** Same ceiling as the rule cap, so a hand-edited map cannot grow unbounded. */
const MAX_LINKS = 100;

function readLinks(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readStorage(LINKS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const links: Record<string, string> = {};
    for (const [ruleId, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ruleId || typeof name !== "string" || !name) continue;
      if (Object.keys(links).length >= MAX_LINKS) break;
      links[ruleId] = name;
    }
    return links;
  } catch {
    return {};
  }
}

/** Saved selection linked to a rule, or "" for the rule's own item. */
export function getAlertSellLink(ruleId: string): string {
  if (!ruleId) return "";
  return readLinks()[ruleId] ?? "";
}

/** An empty name drops the link rather than storing one nothing resolves. */
export function setAlertSellLink(ruleId: string, name: string): void {
  if (!ruleId) return;
  const links = readLinks();
  if (name) links[ruleId] = name;
  else delete links[ruleId];
  writeStorage(LINKS_KEY, JSON.stringify(links));
}

function ownedUnits(item: ParsedItem): number {
  if (typeof item.amount === "number") return item.amount;
  return item.currentlyOwned ? 1 : 0;
}

/** Inventory selection keys for an item rule's slug. The join is the queue's own
 *  `resolveQueueSlug`, so every key picked here can become a bulk sell row. */
export function selectionKeysForAlertRule(
  rule: MarketAlertRule,
  parsedItems: readonly ParsedItem[],
  wfmItems: WfmItemsLookup,
): string[] {
  const slug = toMarketSlug(rule.item?.itemUrlName ?? "");
  if (!slug) return [];
  const keys: string[] = [];
  for (const item of parsedItems) {
    if (ownedUnits(item) <= 0) continue;
    if (toMarketSlug(resolveQueueSlug(item, wfmItems) ?? "") !== slug) continue;
    // Every rank row of a mod shares one selection key; the queue expands them.
    const key = selectionKeyFor(item);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Replaces the bulk sell selection and opens the modal. A linked saved
 *  selection wins; a deleted one falls back to the rule's own item. Owning none
 *  clears the selection so the modal shows its empty-queue message. */
export function openBulkSellForAlertRule(
  rule: MarketAlertRule,
  parsedItems: readonly ParsedItem[],
  wfmItems: WfmItemsLookup,
  saved: readonly SavedSelection[],
): void {
  if (rule.kind !== "item") return;
  const linkName = getAlertSellLink(rule.id);
  const linked = linkName ? (saved.find((entry) => entry.name === linkName) ?? null) : null;
  const keys = linked ? linked.keys : selectionKeysForAlertRule(rule, parsedItems, wfmItems);
  selectKeys(keys, "replace");
  bulkSellOpen.set(true);
}
