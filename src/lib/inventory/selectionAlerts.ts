import { selectionKeyFor } from "../tradeWorkbench/queueModel.js";
import type { SavedSelection } from "../../stores/inventorySelection.js";
import type { ParsedItem } from "../../types/inventory.js";

interface SelectionOwnership {
  owned: number;
  total: number;
  complete: boolean;
}

// Same rule as the bulk sell queue: a stackable row carries its count, and an
// unstacked row is one unit only while the account still holds it.
function ownedUnits(item: ParsedItem): number {
  if (typeof item.amount === "number") return item.amount;
  return item.currentlyOwned ? 1 : 0;
}

function ownedKeys(items: readonly ParsedItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (ownedUnits(item) <= 0) continue;
    const key = selectionKeyFor(item);
    if (key) keys.add(key);
  }
  return keys;
}

// Duplicate keys count once, so a saved set written by an older build cannot
// report a total the grid can never reach.
function ownershipAgainst(
  selection: SavedSelection,
  available: ReadonlySet<string>,
): SelectionOwnership {
  const seen = new Set<string>();
  let owned = 0;
  for (const key of selection.keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (available.has(key)) owned += 1;
  }
  const total = seen.size;
  return { owned, total, complete: total > 0 && owned === total };
}

/** How much of a saved selection the account owns. An empty selection is never
 *  complete, so a set the user emptied cannot fire the alert. */
export function selectionOwnership(
  selection: SavedSelection,
  items: readonly ParsedItem[],
): SelectionOwnership {
  return ownershipAgainst(selection, ownedKeys(items));
}

/** Flagged selections that just crossed into complete. `lastComplete !== true`
 *  is the edge, so a selection that drops back can fire again later. */
export function selectionTransitions(
  selections: readonly SavedSelection[],
  items: readonly ParsedItem[],
): SavedSelection[] {
  const available = ownedKeys(items);
  return selections.filter(
    (selection) =>
      selection.alertWhenComplete === true &&
      selection.lastComplete !== true &&
      ownershipAgainst(selection, available).complete,
  );
}
