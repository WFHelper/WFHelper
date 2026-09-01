import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import type { MarketAlertRule } from "../../../config/shared/marketAlertTypes.js";
import type { ParsedItem } from "../../../src/types/inventory.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";

const LINKS_KEY = "wf_market_alert_sell_links";
const SAVED_KEY = "wf_inventory_saved_selections";

const LOOKUP: WfmItemsLookup = {
  "trinity prime chassis": {
    url_name: "trinity_prime_chassis",
    item_name: "Trinity Prime Chassis",
  },
  "ash prime set": { url_name: "ash_prime_set", item_name: "Ash Prime Set" },
};

function parsedItem(overrides: Partial<ParsedItem>): ParsedItem {
  return { name: "Trinity Prime Chassis", amount: 2, ...overrides } as ParsedItem;
}

function itemRule(overrides: Partial<MarketAlertRule> = {}): MarketAlertRule {
  return {
    id: "rule-1",
    name: "Chassis stock",
    kind: "item",
    enabled: true,
    cooldownMinutes: 60,
    item: { itemUrlName: "trinity_prime_chassis", side: "sell", statuses: [], maxPlatinum: 20 },
    ...overrides,
  };
}

function rivenRule(): MarketAlertRule {
  return { id: "rule-2", name: "Bramma roll", kind: "riven", enabled: true, cooldownMinutes: 60 };
}

/** Both modules read storage at import, so every case needs a fresh copy. */
async function loadModules(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  vi.resetModules();
  const bulk = await import("../../../src/components/market/alerts/alertBulkSell.js");
  const selection = await import("../../../src/stores/inventorySelection.js");
  return { bulk, selection, store };
}

afterEach(() => vi.unstubAllGlobals());

describe("selectionKeysForAlertRule", () => {
  it("keeps the owned rows whose queue slug is the rule's slug", async () => {
    const { bulk } = await loadModules();
    const items = [
      parsedItem({ inventoryKey: "chassis-key" }),
      parsedItem({ name: "Ash Prime Set", internalName: "ash-set", amount: 0 }),
      parsedItem({ name: "Unlisted Thing", internalName: "unlisted", amount: 4 }),
    ];
    expect(bulk.selectionKeysForAlertRule(itemRule(), items, LOOKUP)).toEqual(["chassis-key"]);
  });

  it("falls back to the internal name and skips unowned stock", async () => {
    const { bulk } = await loadModules();
    const items = [
      parsedItem({ internalName: "/Lotus/TrinityChassis", currentlyOwned: true, amount: null }),
      parsedItem({ internalName: "/Lotus/TrinityChassis2", amount: 0 }),
    ];
    expect(bulk.selectionKeysForAlertRule(itemRule(), items, LOOKUP)).toEqual([
      "/Lotus/TrinityChassis",
    ]);
  });

  it("has nothing to sell for a riven rule", async () => {
    const { bulk } = await loadModules();
    expect(bulk.selectionKeysForAlertRule(rivenRule(), [parsedItem({})], LOOKUP)).toEqual([]);
  });
});

describe("openBulkSellForAlertRule", () => {
  it("replaces the selection with the rule's item and opens the modal", async () => {
    const { bulk, selection } = await loadModules();
    selection.selectKeys(["stale"], "replace");
    bulk.openBulkSellForAlertRule(
      itemRule(),
      [parsedItem({ inventoryKey: "chassis-key" })],
      LOOKUP,
      [],
    );
    expect([...get(selection.inventorySelection)]).toEqual(["chassis-key"]);
    expect(get(selection.bulkSellOpen)).toBe(true);
  });

  it("opens with an empty selection when the item is not owned", async () => {
    const { bulk, selection } = await loadModules();
    selection.selectKeys(["stale"], "replace");
    bulk.openBulkSellForAlertRule(itemRule(), [], LOOKUP, []);
    expect(get(selection.inventorySelection).size).toBe(0);
    expect(get(selection.bulkSellOpen)).toBe(true);
  });

  it("applies a linked saved selection instead of the single item", async () => {
    const saved = [{ name: "spares", keys: ["a", "b"] }];
    const { bulk, selection } = await loadModules({
      [LINKS_KEY]: JSON.stringify({ "rule-1": "spares" }),
      [SAVED_KEY]: JSON.stringify(saved),
    });
    bulk.openBulkSellForAlertRule(
      itemRule(),
      [parsedItem({ inventoryKey: "chassis-key" })],
      LOOKUP,
      get(selection.savedSelections),
    );
    expect([...get(selection.inventorySelection)]).toEqual(["a", "b"]);
  });

  it("falls back to the single item when the linked selection is gone", async () => {
    const { bulk, selection } = await loadModules({
      [LINKS_KEY]: JSON.stringify({ "rule-1": "deleted" }),
    });
    bulk.openBulkSellForAlertRule(
      itemRule(),
      [parsedItem({ inventoryKey: "chassis-key" })],
      LOOKUP,
      get(selection.savedSelections),
    );
    expect([...get(selection.inventorySelection)]).toEqual(["chassis-key"]);
  });

  it("does nothing for a riven rule", async () => {
    const { bulk, selection } = await loadModules();
    selection.selectKeys(["kept"], "replace");
    bulk.openBulkSellForAlertRule(rivenRule(), [parsedItem({})], LOOKUP, []);
    expect([...get(selection.inventorySelection)]).toEqual(["kept"]);
    expect(get(selection.bulkSellOpen)).toBe(false);
  });
});

describe("alert sell links", () => {
  it("stores a link, reads it back and drops it on an empty name", async () => {
    const { bulk, store } = await loadModules();
    bulk.setAlertSellLink("rule-1", "spares");
    expect(bulk.getAlertSellLink("rule-1")).toBe("spares");
    expect(JSON.parse(store.get(LINKS_KEY) ?? "{}")).toEqual({ "rule-1": "spares" });

    bulk.setAlertSellLink("rule-1", "");
    expect(bulk.getAlertSellLink("rule-1")).toBe("");
    expect(JSON.parse(store.get(LINKS_KEY) ?? "{}")).toEqual({});
  });

  it("ignores corrupt storage and non-string entries", async () => {
    const corrupt = await loadModules({ [LINKS_KEY]: "{not json" });
    expect(corrupt.bulk.getAlertSellLink("rule-1")).toBe("");

    const wrongType = await loadModules({ [LINKS_KEY]: JSON.stringify({ "rule-1": 7 }) });
    expect(wrongType.bulk.getAlertSellLink("rule-1")).toBe("");
  });
});
