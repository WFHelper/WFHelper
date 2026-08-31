import { describe, expect, it } from "vitest";

import {
  INVENTORY_LIST_COLUMNS,
  nextInventorySort,
} from "../../../src/components/inventory/inventoryListColumns.js";
import { applySharedFiltersAndSort, defaultSortDirection } from "../../../src/lib/filters.js";
import type { InventoryViewItem } from "../../../src/lib/inventoryMarket.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";

function defaultFilters(): SharedFiltersState {
  return {
    search: "",
    primeMode: "all",
    masteredMode: "all",
    sortBy: "name",
    sortDirection: "asc",
    orderPlaced: "all",
    mastered: "all",
    spares: "all",
    vaulted: "all",
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    minimumAmount: 0,
    equipped: "all",
    leveledUp: "all",
    subsumed: "all",
    foundryState: "all",
  };
}

function row(name: string, extra: Partial<InventoryViewItem> = {}): InventoryViewItem {
  return {
    name,
    internalName: `/Lotus/Types/${name.replace(/\s+/g, "")}`,
    category: "parts",
    categoryLabel: "Prime Part",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: name.includes("Prime"),
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    inventoryGroup: "all_parts",
    partType: "prime",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: null,
    marketThumb: null,
    subtype: null,
    platinum: null,
    platinumR0: null,
    platinumRmax: null,
    wtsR0: null,
    wtbR0: null,
    wtsRmax: null,
    wtbRmax: null,
    ducats: null,
    ducatonator: null,
    displayImageUrl: null,
    usesFallbackArt: false,
    equippedSummary: null,
    ...extra,
  };
}

describe("INVENTORY_LIST_COLUMNS", () => {
  it("covers every data point a card shows, in reading order", () => {
    expect(INVENTORY_LIST_COLUMNS.map((column) => column.key)).toEqual([
      "icon",
      "name",
      "owned",
      "mastery",
      "platinum",
      "ducats",
      "order",
    ]);
  });

  it("marks the counted columns numeric so they render tabular", () => {
    const numeric = INVENTORY_LIST_COLUMNS.filter((column) => column.numeric).map((c) => c.key);
    expect(numeric).toEqual(["owned", "platinum", "ducats"]);
  });

  it("sorts only through keys the shared sort store already understands", () => {
    const sortKeys = INVENTORY_LIST_COLUMNS.flatMap((column) =>
      column.sortKey ? [[column.key, column.sortKey]] : [],
    );
    expect(sortKeys).toEqual([
      ["name", "name"],
      ["owned", "amount"],
      ["platinum", "platinum"],
      ["ducats", "ducats"],
    ]);
  });

  it("leaves the artwork column unlabelled and unsortable", () => {
    const icon = INVENTORY_LIST_COLUMNS[0];
    expect(icon.labelKey).toBeNull();
    expect(icon.sortKey).toBeNull();
  });
});

describe("nextInventorySort", () => {
  it("starts a new column at the direction the sort dropdown would pick", () => {
    expect(nextInventorySort({ sortBy: "name", sortDirection: "asc" }, "platinum")).toEqual({
      sortBy: "platinum",
      sortDirection: defaultSortDirection("platinum"),
    });
    expect(nextInventorySort({ sortBy: "platinum", sortDirection: "desc" }, "name")).toEqual({
      sortBy: "name",
      sortDirection: defaultSortDirection("name"),
    });
  });

  it("flips the active column in both directions", () => {
    expect(nextInventorySort({ sortBy: "ducats", sortDirection: "desc" }, "ducats")).toEqual({
      sortBy: "ducats",
      sortDirection: "asc",
    });
    expect(nextInventorySort({ sortBy: "ducats", sortDirection: "asc" }, "ducats")).toEqual({
      sortBy: "ducats",
      sortDirection: "desc",
    });
  });

  it("writes a patch the shared filter store accepts as-is", () => {
    const patch = nextInventorySort({ sortBy: "name", sortDirection: "asc" }, "amount");
    const filters: SharedFiltersState = { ...defaultFilters(), ...patch };
    const items = [
      row("Ash Prime Systems", { amount: 1 }),
      row("Braton Prime Barrel", { amount: 9 }),
    ];

    expect(applySharedFiltersAndSort(items, filters).map((item) => item.amount)).toEqual([9, 1]);
  });
});

describe("shared view-model", () => {
  // The list and the grid are two renderers over one array: InventoryView filters,
  // sorts and pages once and hands the same slice to whichever is mounted. This
  // guards the pipeline against growing a per-mode branch; the DOM row counts
  // themselves are asserted in e2e/inventory-list.spec.ts.
  const items = [
    row("Ash Prime Systems", { platinum: 12 }),
    row("Braton Prime Barrel", { platinum: 4 }),
    row("Nikana Prime Blade", { platinum: 30 }),
    row("Rubico Prime Stock", { platinum: 7 }),
    row("Forma Blueprint", { isPrime: false, categoryLabel: "Blueprint", platinum: null }),
  ];
  const PAGE_SIZE = 3;

  function pagedRows(filters: SharedFiltersState): InventoryViewItem[] {
    const visible = applySharedFiltersAndSort(items, filters);
    return visible.length > PAGE_SIZE ? visible.slice(0, PAGE_SIZE) : visible;
  }

  it("pages one filtered result set that neither renderer narrows", () => {
    const filters: SharedFiltersState = { ...defaultFilters(), search: "prime" };
    const page = pagedRows(filters);

    expect(applySharedFiltersAndSort(items, filters)).toHaveLength(4);
    expect(page).toHaveLength(PAGE_SIZE);
    expect(page.map((item) => item.internalName)).toEqual([
      "/Lotus/Types/AshPrimeSystems",
      "/Lotus/Types/BratonPrimeBarrel",
      "/Lotus/Types/NikanaPrimeBlade",
    ]);
  });

  it("keeps the same rows after a column header re-sorts", () => {
    const filters: SharedFiltersState = { ...defaultFilters(), search: "prime" };
    const before = pagedRows(filters);
    const sorted = pagedRows({
      ...filters,
      ...nextInventorySort(filters, "platinum"),
    });

    expect(sorted).toHaveLength(before.length);
    expect(sorted.map((item) => item.platinum)).toEqual([30, 12, 7]);
  });
});
