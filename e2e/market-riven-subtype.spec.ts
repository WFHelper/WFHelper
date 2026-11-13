import { expect, test } from "@playwright/test";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// A veiled riven is priced by reveal state (subtype), never by rank. Creating one
// used to be refused by the create-order validator, which only knew relic
// refinements and mod variants.
test("creates a veiled riven order with an unrevealed subtype and no rank field", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-riven-subtype-");
    const { app, page } = harness;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await evaluateInMain(app, ({ app, ipcMain }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const client = load("./services/wfmClient.js") as {
        requestV2: (
          method: string,
          path: string,
          options?: { json?: Record<string, unknown> },
        ) => Promise<unknown>;
      };
      const riven = {
        id: "675c61ff7b18977f6e645430",
        slug: "rifle_riven_mod_veiled",
        item_name: "Rifle Riven Mod (Veiled)",
        maxRank: null,
        subtypes: ["unrevealed", "revealed"],
      };
      let saved: Record<string, unknown> | null = null;
      client.requestV2 = async (method, path, options) => {
        if (method === "GET" && path === `/item/${riven.slug}`) return { data: riven };
        if (method === "POST" && path === "/order") {
          const body = options?.json ?? {};
          saved = {
            id: "111111111111111111111111",
            orderType: body.type,
            platinum: body.platinum,
            quantity: body.quantity,
            modRank: body.rank,
            subtype: body.subtype,
            visible: true,
            itemId: body.itemId,
            itemName: riven.item_name,
            itemUrlName: riven.slug,
            itemThumb: null,
          };
          return { data: { id: saved.id, ...body } };
        }
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      };
      for (const channel of ["wfm:session", "wfm:search-items", "wfm:get-orders"])
        ipcMain.removeHandler(channel);
      ipcMain.handle("wfm:session", () => ({
        loggedIn: true,
        userName: "Fixture",
        platform: "pc",
      }));
      ipcMain.handle("wfm:search-items", (_event, payload: { query: string }) =>
        riven.item_name.toLowerCase().includes(payload.query.toLowerCase())
          ? [{ ...riven, url_name: riven.slug, thumb: null, icon: null }]
          : [],
      );
      ipcMain.handle("wfm:get-orders", () => ({ sell: saved ? [saved] : [], buy: [] }));
      ipcMain.removeHandler("get-wfm-items");
      ipcMain.handle("get-wfm-items", () => ({
        [riven.item_name.toLowerCase()]: { ...riven, url_name: riven.slug },
      }));
    });
    await page.reload();
    await setLayoutViewport(page, 1280, 900);
    await page.locator('#sidebar [data-view="market"]').click();
    await page.locator("[data-market-new-order]").click();
    await page.locator("#order-item-search").fill("Riven");
    await page.locator("[data-order-item='rifle_riven_mod_veiled']").click();
    await expect(page.locator("[data-order-details-loading]")).toHaveCount(0);
    // The item is rankless, so the modal must not offer a rank field.
    await expect(page.locator("#order-rank")).toHaveCount(0);
    await expect(page.locator("[data-order-subtype]")).toHaveValue("");
    await page.locator("[data-order-subtype]").selectOption("unrevealed");
    await page.locator("#order-platinum").fill("12");
    await page.locator("#order-quantity").fill("1");
    await page.locator('[data-order-modal="create"] button[type="submit"]').click();
    // A blocked payload would leave the modal open with the validation error.
    await expect(page.locator("[data-order-modal]")).toHaveCount(0);
    type FixtureOrder = {
      subtype: string;
      platinum: number;
      quantity: number;
      modRank?: number | null;
    };
    const orders = (await page.evaluate(() => window.api.wfmGetOrders())) as {
      sell: FixtureOrder[];
    };
    expect(orders.sell[0]).toMatchObject({ subtype: "unrevealed", platinum: 12, quantity: 1 });
    // A rankless item must not send or persist a rank.
    expect(orders.sell[0].modRank ?? null).toBeNull();
    await expect(page.locator("[data-order-subtype-chip]").first()).toHaveText("Unrevealed");
    expect(errors).toEqual([]);
  } catch (error) {
    if (harness) {
      await harness.page.screenshot({ path: "test-results/riven-subtype-failure.png" });
    }
    throw error;
  } finally {
    await closeElectronTestHarness(harness);
  }
});
