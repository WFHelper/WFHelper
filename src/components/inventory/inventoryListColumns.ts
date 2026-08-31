import { defaultSortDirection } from "../../lib/filters.js";
import type { MessageKey } from "../../lib/i18n.js";
import type { SharedSortKey, SortDirection } from "../../types/filters.js";

interface InventoryListColumn {
  key: string;
  /** null on the artwork column, which carries no header text. */
  labelKey: MessageKey | null;
  /**
   * The shared sort key this header writes. null means the column has no key in
   * the shared sort store, so it renders as plain text instead of a button.
   */
  sortKey: SharedSortKey | null;
  numeric: boolean;
}

export const INVENTORY_LIST_COLUMNS = [
  { key: "icon", labelKey: null, sortKey: null, numeric: false },
  { key: "name", labelKey: "common.name", sortKey: "name", numeric: false },
  { key: "owned", labelKey: "common.owned", sortKey: "amount", numeric: true },
  { key: "mastery", labelKey: "common.mastery", sortKey: null, numeric: false },
  { key: "platinum", labelKey: "common.platinum", sortKey: "platinum", numeric: true },
  { key: "ducats", labelKey: "common.ducats", sortKey: "ducats", numeric: true },
  { key: "order", labelKey: "filters.orderPlaced", sortKey: null, numeric: false },
] as const satisfies readonly InventoryListColumn[];

/**
 * Re-clicking the active column flips it; a new column starts at the direction
 * the shared sort bar would pick, so both entry points agree on "best first".
 */
export function nextInventorySort(
  current: { sortBy: SharedSortKey; sortDirection: SortDirection },
  sortKey: SharedSortKey,
): { sortBy: SharedSortKey; sortDirection: SortDirection } {
  if (current.sortBy !== sortKey) {
    return { sortBy: sortKey, sortDirection: defaultSortDirection(sortKey) };
  }
  return {
    sortBy: sortKey,
    sortDirection: current.sortDirection === "asc" ? "desc" : "asc",
  };
}
