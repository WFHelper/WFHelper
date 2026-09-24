import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

import {
  DB_GET_ITEM_DATABASE,
  WFM_GET_ORDERS,
  WFM_UPDATE_ORDER,
} from "../config/shared/ipcChannels";
import { mainWindow } from "./mainWindow";
import { evaluateInMain } from "./electronTestHarness";

// Ids must satisfy the IPC validator's 24-hex WFM ObjectId shape.
function fixtureId(index: number): string {
  return (index + 1).toString(16).padStart(24, "0");
}

const BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeBarrel";
const RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeReceiver";
const STOCK = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeStock";
const BLADE = "/Lotus/Types/Recipes/Weapons/WeaponParts/DakraPrimeBlade";

// A synthetic database keeps the display names the join needs out of the live
// DE export, so the expected owned counts are fixed by this file alone.
const ITEM_DB = {
  [BARREL]: { name: "Braton Prime Barrel", tradable: true, isPrime: true },
  [RECEIVER]: { name: "Braton Prime Receiver", tradable: true, isPrime: true },
  [STOCK]: { name: "Braton Prime Stock", tradable: true, isPrime: true },
  [BLADE]: { name: "Dakra Prime Blade", tradable: true, isPrime: true },
};

const INVENTORY = {
  Suits: [],
  MiscItems: [
    { ItemType: BARREL, ItemCount: 5 },
    { ItemType: RECEIVER, ItemCount: 2 },
    { ItemType: BLADE, ItemCount: 4 },
  ],
};

interface FixtureOrder {
  id: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  itemId: string | null;
  itemName: string;
  itemUrlName: string;
  itemThumb: string | null;
}

function sellOrder(
  index: number,
  itemName: string,
  urlName: string,
  quantity: number,
): FixtureOrder {
  return {
    id: fixtureId(index),
    orderType: "sell",
    platinum: 10 + index,
    quantity,
    visible: true,
    modRank: null,
    itemId: `fixture-item-${index}`,
    itemName,
    itemUrlName: urlName,
    itemThumb: null,
  };
}

function fixtureOrders(): { sell: FixtureOrder[]; buy: FixtureOrder[] } {
  return {
    sell: [
      sellOrder(0, "Braton Prime Barrel", "braton_prime_barrel", 1),
      sellOrder(1, "Braton Prime Receiver", "braton_prime_receiver", 9),
      sellOrder(2, "Braton Prime Stock", "braton_prime_stock", 3),
      sellOrder(3, "Dakra Prime Blade", "dakra_prime_blade", 4),
    ],
    buy: [{ ...sellOrder(4, "Braton Prime Barrel", "braton_prime_barrel", 1), orderType: "buy" }],
  };
}

interface QuantitySyncFixture {
  orders: { sell: FixtureOrder[]; buy: FixtureOrder[] };
  updates: Array<{ orderId: string; platinum: unknown; quantity: unknown }>;
  messages: string[];
  answer: boolean;
}

type FixtureGlobal = typeof globalThis & { quantitySyncFixture: QuantitySyncFixture };

test.describe("Market quantity sync", () => {
  test.setTimeout(240_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-qty-sync-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });
    const fixturePath = path.join(sandboxDir, "wfm-orders.json");
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureOrders()));
    const helperDir = path.join(sandboxDir, "user-data", "api-helper");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "inventory.json"), JSON.stringify(INVENTORY));

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.WFHELPER_DISABLE_DBWIN = "1";
    env.LOCALAPPDATA = localAppData;
    env.APPDATA = path.join(sandboxDir, "roaming");
    env.WFHELPER_USER_DATA = path.join(sandboxDir, "user-data");
    env.WFHELPER_WFM_FIXTURES = fixturePath;

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
    page = await mainWindow(app);

    await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => {
      localStorage.setItem("setup-completed-v2", "1");
      localStorage.setItem("feature-tour-done", "1");
      localStorage.setItem("app-language", "en");
    });

    await evaluateInMain(
      app,
      ({ ipcMain, dialog }, payload) => {
        const state: QuantitySyncFixture = {
          orders: payload.orders,
          updates: [],
          messages: [],
          answer: true,
        };
        (globalThis as FixtureGlobal).quantitySyncFixture = state;

        ipcMain.removeHandler(payload.itemDbChannel);
        ipcMain.handle(payload.itemDbChannel, () => payload.itemDb);

        // The native confirmation would block the run, so it answers itself and
        // keeps the message for the count assertion.
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = (args.length > 1 ? args[1] : args[0]) as { message?: string };
          state.messages.push(String(options?.message ?? ""));
          return { response: state.answer ? 0 : 1 };
        }) as unknown as typeof dialog.showMessageBox;

        const load = process
          .getBuiltinModule("module")
          .createRequire(`${payload.appPath}/.electron-build/main.js`);
        const security = load("./ipc/ipcSecurity.js") as typeof import("../ipc/ipcSecurity");

        // The order list moves here so the 30s background refresh reads back
        // what the run just wrote instead of the untouched fixture file.
        ipcMain.removeHandler(payload.ordersChannel);
        security.handleAuthorized(payload.ordersChannel, security.assertMainRendererSender, () => ({
          sell: state.orders.sell.map((entry) => ({ ...entry })),
          buy: state.orders.buy.map((entry) => ({ ...entry })),
        }));

        ipcMain.removeHandler(payload.updateChannel);
        security.handleAuthorized(
          payload.updateChannel,
          security.assertMainRendererSender,
          (_event: unknown, body: unknown) => {
            const sent = (body ?? {}) as { orderId?: string; updates?: Record<string, unknown> };
            const quantity = sent.updates?.quantity;
            const platinum = sent.updates?.platinum;
            state.updates.push({ orderId: String(sent.orderId ?? ""), platinum, quantity });
            const order = [...state.orders.sell, ...state.orders.buy].find(
              (entry) => entry.id === sent.orderId,
            );
            if (!order) return { error: "Order not found." };
            if (typeof quantity === "number") order.quantity = quantity;
            if (typeof platinum === "number") order.platinum = platinum;
            return { ok: true };
          },
        );
      },
      {
        appPath: await app.evaluate(({ app: instance }) => instance.getAppPath()),
        itemDbChannel: DB_GET_ITEM_DATABASE,
        ordersChannel: WFM_GET_ORDERS,
        updateChannel: WFM_UPDATE_ORDER,
        itemDb: ITEM_DB,
        orders: fixtureOrders(),
      },
    );

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await page.locator('#sidebar [data-view="market"]').click();
    await expect(page.locator('[data-market-orders-heading="orders"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".order-row")).toHaveCount(4);
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  function fixtureState(): Promise<QuantitySyncFixture> {
    return evaluateInMain(app, () => (globalThis as FixtureGlobal).quantitySyncFixture);
  }

  function quantityOf(index: number): Locator {
    return page
      .locator(".order-row")
      .filter({ has: page.locator(`[data-order-edit="${fixtureId(index)}"]`) })
      .locator('input[type="number"]')
      .first();
  }

  test("the button belongs to the sell tab alone", async () => {
    await expect(page.locator("[data-market-sync-quantities]")).toBeVisible();

    await page.locator('[data-tour-tab="buy"]').click();
    await expect(page.locator(".order-row")).toHaveCount(1);
    await expect(page.locator("[data-market-sync-quantities]")).toHaveCount(0);

    await page.locator('[data-tour-tab="sell"]').click();
    await expect(page.locator("[data-market-sync-quantities]")).toBeVisible();
  });

  test("every listing the inventory backs follows the owned count", async () => {
    await page.locator("[data-market-sync-quantities]").click();

    await expect.poll(async () => (await fixtureState()).updates.length).toBe(2);
    const state = await fixtureState();
    expect(state.messages[0]).toContain("2");
    expect(state.messages[0]).toContain("1");
    expect(state.updates).toEqual([
      { orderId: fixtureId(0), platinum: undefined, quantity: 5 },
      { orderId: fixtureId(1), platinum: undefined, quantity: 2 },
    ]);
    expect(state.updates.some((entry) => entry.orderId === fixtureId(2))).toBe(false);

    await expect(quantityOf(0)).toHaveValue("5");
    await expect(quantityOf(1)).toHaveValue("2");
    await expect(quantityOf(2)).toHaveValue("3");
    await expect(quantityOf(3)).toHaveValue("4");
  });

  test("a second run asks nothing and sends nothing", async () => {
    const before = await fixtureState();
    await page.locator("[data-market-sync-quantities]").click();

    await page.waitForTimeout(500);
    const after = await fixtureState();
    expect(after.messages.length).toBe(before.messages.length);
    expect(after.updates.length).toBe(before.updates.length);
  });
});
