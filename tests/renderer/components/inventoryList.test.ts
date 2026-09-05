import { describe, expect, it } from "vitest";

import {
  INVENTORY_LIST_COLUMNS,
  nextInventorySort,
  ownedSortKeyFor,
} from "../../../src/components/inventory/inventoryListColumns.js";
import { applySharedFiltersAndSort, defaultSortDirection } from "../../../src/lib/filters.js";
import type { InventoryViewItem } from "../../../src/lib/inventoryMarket.js";
import type { SharedFiltersState, SharedSortKey } from "../../../src/types/filters.js";

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

describe("ownedSortKeyFor", () => {
  // The Owned cell shows a parts fraction on incomplete sets, so the header must
  // not offer the plain quantity sort there.
  it("keeps the quantity sort when no row is an incomplete set", () => {
    expect(ownedSortKeyFor(["all_parts", "full_sets", "mods"])).toBe("amount");
    expect(ownedSortKeyFor([])).toBe("amount");
  });

  it("sorts an all-incomplete list by set completeness", () => {
    expect(ownedSortKeyFor(["incomplete_sets", "incomplete_sets"])).toBe("missing_parts");
  });

  it("drops the sort affordance when the list mixes both", () => {
    expect(ownedSortKeyFor(["full_sets", "incomplete_sets"])).toBeNull();
  });

  it("only offers keys the full-sets tab can actually compute", () => {
    const fullSetsKeys = new Set([
      "name",
      "platinum",
      "ducats",
      "amount",
      "ducatonator",
      "complete_sets",
      "missing_parts",
    ]);
    const key = ownedSortKeyFor(["incomplete_sets"]);
    expect(key).not.toBeNull();
    expect(fullSetsKeys.has(key as string)).toBe(true);
  });
});

describe("owned header over a paged list", () => {
  // Full Sets with "show incomplete sets" mixes both groups, and InventoryView
  // hands the renderer a 120-row page. Reading the mix off that page offers the
  // quantity sort while later rows still render an x/y fraction, and makes the
  // header flip as paging pulls the rest in.
  const visible = [
    row("Ash Prime Set", { inventoryGroup: "full_sets", amount: 1 }),
    row("Braton Prime Set", { inventoryGroup: "full_sets", amount: 2 }),
    row("Nikana Prime Set", { inventoryGroup: "full_sets", amount: 1 }),
    row("Rubico Prime Set", {
      inventoryGroup: "incomplete_sets",
      ownedPartTypes: 2,
      totalPartTypes: 4,
    }),
  ];
  const PAGE_SIZE = 3;

  // vitest cannot compile `.svelte`, so InventoryList's header derivation is
  // mirrored here: `ownedSortKeyFor((allItems ?? items).map((i) => i.inventoryGroup))`.
  function headerSortKey(
    items: InventoryViewItem[],
    allItems: InventoryViewItem[] | null,
  ): SharedSortKey | null {
    return ownedSortKeyFor((allItems ?? items).map((item) => item.inventoryGroup));
  }

  it("drops the sort the page slice on its own would have offered", () => {
    const page = visible.slice(0, PAGE_SIZE);
    expect(headerSortKey(page, null)).toBe("amount");
    expect(headerSortKey(page, visible)).toBeNull();
  });

  it("holds one key as paging extends the slice", () => {
    const keys = [1, PAGE_SIZE, visible.length].map((limit) =>
      headerSortKey(visible.slice(0, limit), visible),
    );
    expect(keys).toEqual([null, null, null]);
  });

  it("still reads the page when the caller passes no full list", () => {
    expect(headerSortKey(visible, null)).toBeNull();
    expect(headerSortKey(visible.slice(3), null)).toBe("missing_parts");
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
