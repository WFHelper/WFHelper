import { test, expect as baseExpect } from "@playwright/test";

import { DB_GET_ITEM_DATABASE, DB_GET_WFM_ITEMS } from "../config/shared/ipcChannels";
import type { WfmItemsLookup } from "../src/types/ipc";
import type { ItemDbEntry } from "../src/types/inventory";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";
import { createOfflineScenario } from "./offlineScenario";

const expect = baseExpect.configure({ timeout: 20_000 });
const FRAME = "/Lotus/Powersuits/Mag/MagPrime";
// Long past under the scenario's frozen clock as well as the renderer's real one.
const CLAIMED_LONG_AGO = Date.UTC(2020, 0, 1);
const ITEM_REF = "/Lotus/Upgrades/Mods/Pistol/Event/Nightwave/NightwaveLasGooPistolAugmentMod";
const CATALOG_ITEM = {
  gameRef: ITEM_REF,
  item_name: "Prototype Shock Coils",
  url_name: "prototype_shock_coils",
  maxRank: 5,
};
const CATALOG: WfmItemsLookup = {
  [ITEM_REF.toLowerCase()]: CATALOG_ITEM,
  "prototype shock coils": CATALOG_ITEM,
};

test("inventory resolves missing Nightwave metadata and keeps catalog entries unowned", async () => {
  test.setTimeout(180_000);
  const scenario = createOfflineScenario("world-darvo");
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-inventory-metadata-", {
      ...scenario,
      inventory: {
        Suits: [],
        Upgrades: [{ ItemType: ITEM_REF, ItemCount: 1, Rank: 0 }],
      },
    });
    const database: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Test/UnownedSentinel": { name: "Unowned Fixture", category: "Weapon" },
    };
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, payload) => {
        // Filesystem write-stability polling needs time to advance after offline startup.
        globalThis.Date = Date.prototype.constructor as DateConstructor;
        ipcMain.removeHandler(payload.itemDbChannel);
        ipcMain.handle(payload.itemDbChannel, () => payload.database);
        ipcMain.removeHandler(payload.catalogChannel);
        ipcMain.handle(payload.catalogChannel, () => payload.catalog);
      },
      {
        itemDbChannel: DB_GET_ITEM_DATABASE,
        catalogChannel: DB_GET_WFM_ITEMS,
        database,
        catalog: CATALOG,
      },
    );
    const { page } = harness;
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url !== "https://api.warframe.market/v2/orders/item/prototype_shock_coils") {
          return original(input, init);
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                type: "sell",
                platinum: 18,
                quantity: 1,
                rank: 0,
                visible: true,
                user: { ingameName: "FixtureSeller", status: "ingame" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
    });
    await page.reload();
    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('[data-tour="inventory-tabs"] [data-tour-tab="mods"]').click();
    const cards = page.locator("[data-inventory-card]");
    await expect(cards).toHaveCount(1);
    await expect(cards.locator(".item-name")).toHaveText("Prototype Shock Coils");
    await expect(cards.locator(".item-rank-text")).toHaveText("0/5");
    await expect(cards).toContainText("x1");
    await expect(cards).toHaveAttribute("data-inventory-card", `${ITEM_REF}#r0m10`);
    expect(
      await page.evaluate(
        async (reference) => (await window.api.getItemDatabase())[reference],
        ITEM_REF,
      ),
    ).toBeUndefined();
    await cards.click();
    const panel = page.locator("[data-orderbook-panel]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Prototype Shock Coils");
    await expect(panel.locator('[data-orderbook-unit-plat="18"]')).toBeVisible();
    const ranks = panel.locator("select.inventory-orderbook-select").first();
    await expect(ranks.locator("option")).toHaveCount(6);
    expect(
      await ranks
        .locator("option")
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(["0", "1", "2", "3", "4", "5"]);
    await page.screenshot({ path: test.info().outputPath("prototype-shock-coils.png") });
    await page.locator("[data-orderbook-close]").click();

    writeHarnessInventory(harness, { Suits: [], Upgrades: [] });
    await expect(cards).toHaveCount(0);
    expect(
      await page.evaluate(
        async () => (await window.api.getWfmItems())["prototype shock coils"].maxRank,
      ),
    ).toBe(5);
    await page.screenshot({ path: test.info().outputPath("catalog-with-empty-inventory.png") });
  } finally {
    await closeElectronTestHarness(harness);
    scenario.dispose();
  }
});

test("a part whose parent waits in the foundry carries the claim mark", async () => {
  test.setTimeout(180_000);
  const scenario = createOfflineScenario("world-darvo");
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-inventory-foundry-mark-", {
      ...scenario,
      inventory: { Suits: [] },
    });
    const { page } = harness;
    await evaluateInMain(
      harness.app,
      () => {
        // Filesystem write-stability polling needs time to advance after offline startup.
        globalThis.Date = Date.prototype.constructor as DateConstructor;
      },
      null,
    );

    const parent = await page.evaluate(async (frame) => {
      const db = (await window.api.getItemDatabase()) as unknown as Record<
        string,
        {
          components?: Array<{ uniqueName?: string }>;
          recipe?: { blueprintUniqueName?: string };
        }
      >;
      const blueprint = db[frame]?.recipe?.blueprintUniqueName;
      const part = db[frame]?.components?.find((entry) => entry.uniqueName)?.uniqueName;
      return blueprint && part ? { blueprint, part } : null;
    }, FRAME);
    if (!parent) throw new Error("the item database has no Mag Prime recipe with a named part");
    const { blueprint, part } = parent;

    // The frame itself stays unowned, so C cannot answer for the part instead.
    writeHarnessInventory(harness, {
      Suits: [],
      MiscItems: [{ ItemType: part, ItemCount: 2 }],
      PendingRecipes: [
        {
          ItemType: blueprint,
          CompletionDate: { $date: { $numberLong: String(CLAIMED_LONG_AGO) } },
        },
      ],
    });
    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('[data-tour="inventory-tabs"] [data-tour-tab="all_parts"]').click();
    const card = page.locator(`[data-inventory-card="${part}"]`);
    await expect(card.locator('[data-item-mark="foundry"]')).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-item-mark="foundry"]')).toHaveText("F");
    await expect(card.locator('[data-item-mark="crafted"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("foundry-claim-mark.png") });

    // F has its own switch, so hiding the C badges must leave it in place.
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="inventory"]').click();
    await page.locator('[data-setting="show-owned-parent-badges"] input').uncheck();
    await page.locator('#sidebar [data-view="inventory"]').click();
    await expect(card.locator('[data-item-mark="foundry"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-setting="show-foundry-ready-badges"] input').uncheck();
    await page.locator('#sidebar [data-view="inventory"]').click();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('[data-item-mark="foundry"]')).toHaveCount(0);
  } finally {
    await closeElectronTestHarness(harness);
    scenario.dispose();
  }
});
