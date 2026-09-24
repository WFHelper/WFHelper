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

import { mainWindow } from "./mainWindow";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Ids must satisfy the IPC validator's 24-hex WFM ObjectId shape.
function fixtureId(index: number): string {
  return (index + 1).toString(16).padStart(24, "0");
}

function fixtureOrders(): { sell: unknown[]; buy: unknown[] } {
  const sell = Array.from({ length: 3 }, (_, index) => ({
    id: fixtureId(index),
    orderType: "sell",
    platinum: 10 + index,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: `fixture-item-${index + 1}`,
    itemName: `Fixture Item ${index + 1}`,
    itemUrlName: `fixture_item_${index + 1}`,
    itemThumb: null,
  }));
  return { sell, buy: [] };
}

test.describe("Market reprice (fixture mode)", () => {
  test.setTimeout(240_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-reprice-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });
    const fixturePath = path.join(sandboxDir, "wfm-orders.json");
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureOrders()));
    const helperDir = path.join(sandboxDir, "user-data", "api-helper");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "inventory.json"), JSON.stringify({ Suits: [] }));

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
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await page.locator('#sidebar [data-view="market"]').click();
    await expect(page.locator('[data-market-orders-heading="orders"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  // A failed test restarts the worker, so later tests reopen the modal themselves.
  async function openModal(): Promise<Locator> {
    const modal = page.locator("[data-reprice-modal]");
    if (!(await modal.isVisible())) {
      await page.locator("[data-market-select-all]").first().click();
      await page.locator("[data-market-reprice]").click();
      await expect(modal).toBeVisible({ timeout: 20_000 });
    }
    return modal;
  }

  test("selected listings open a reprice preview at their current prices", async () => {
    await expect(page.locator("[data-market-reprice]")).toHaveCount(0);

    await page.locator("[data-market-select-all]").first().click();
    const reprice = page.locator("[data-market-reprice]");
    await expect(reprice).toBeVisible();
    await reprice.click();

    const modal = page.locator("[data-reprice-modal]");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(modal.locator("[data-reprice-row]")).toHaveCount(3);
    await expect(modal.locator("[data-reprice-strategy]")).toBeVisible();

    await expect(modal.locator("[data-reprice-apply]")).toBeDisabled();
  });

  test("a minimum platinum bound drops the cheaper listings from the list", async () => {
    const modal = await openModal();
    const rows = modal.locator("[data-reprice-row]");

    await modal.locator("[data-reprice-min-plat]").fill("12");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("data-reprice-row", fixtureId(2));

    await modal.locator("[data-reprice-min-plat]").fill("");
    await expect(rows).toHaveCount(3);
  });

  test("quick select clears every row and then picks only the filtered ones", async () => {
    const modal = await openModal();
    const box = (index: number): Locator =>
      modal.locator(`[data-reprice-select="${fixtureId(index)}"]`);

    await modal.locator("[data-reprice-select-none]").click();
    for (const index of [0, 1, 2]) await expect(box(index)).not.toBeChecked();
    await expect(modal.locator("[data-reprice-apply]")).toBeDisabled();

    await modal.locator("[data-reprice-min-plat]").fill("12");
    await modal.locator("[data-reprice-select-all]").click();
    await modal.locator("[data-reprice-min-plat]").fill("");
    await expect(modal.locator("[data-reprice-row]")).toHaveCount(3);
    await expect(box(0)).not.toBeChecked();
    await expect(box(1)).not.toBeChecked();
    await expect(box(2)).toBeChecked();

    await modal.locator("[data-reprice-select-all]").click();
    for (const index of [0, 1, 2]) await expect(box(index)).toBeChecked();

    // Narrowing without clearing first: every listing starts selected, so this
    // has to replace the selection or Apply would still send the hidden rows.
    await modal.locator("[data-reprice-min-plat]").fill("12");
    await modal.locator("[data-reprice-select-all]").click();
    await modal.locator("[data-reprice-min-plat]").fill("");
    await expect(box(0)).not.toBeChecked();
    await expect(box(1)).not.toBeChecked();
    await expect(box(2)).toBeChecked();
  });
});

interface RepriceFixture {
  mode: "success" | "partial" | "hold" | "unauthorized";
  requests: { id: string; body: Record<string, unknown> }[];
  release?: () => void;
  holdReads?: boolean;
  heldReads: number;
  releaseRead?: () => void;
}

test.describe("Market reprice through production IPC", () => {
  let harness: ElectronTestHarness;
  let pageErrors: string[];

  test.beforeEach(async () => {
    pageErrors = [];
    harness = await launchElectronTestHarness("wfh-reprice-ipc-", {
      onPage: async (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.addInitScript(() => {
          const originalFetch = window.fetch;
          window.fetch = async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!url.startsWith("https://api.warframe.market/")) return originalFetch(input, init);
            return new Response(
              JSON.stringify({
                data: [
                  {
                    type: "sell",
                    platinum: 50,
                    quantity: 10,
                    user: { ingameName: "Fixture Rival", status: "ingame" },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          };
        });
      },
    });
    await evaluateInMain(harness.app, async ({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const client = load("./services/wfmClient.js") as typeof import("../services/wfmClient");
      const session = load("./services/wfmSession.js") as typeof import("../services/wfmSession");
      const { WfmApiError } = load(
        "./services/wfmTypes.js",
      ) as typeof import("../services/wfmTypes");
      const state: RepriceFixture = { mode: "success", requests: [], heldReads: 0 };
      (globalThis as typeof globalThis & { repriceFixture: RepriceFixture }).repriceFixture = state;
      const orders = Array.from({ length: 3 }, (_, index) => ({
        id: (index + 1).toString(16).padStart(24, "0"),
        type: "sell",
        platinum: 10 + index,
        quantity: index + 1,
        visible: true,
        item: {
          id: `item-${index}`,
          item_name: `Fixture Item ${index + 1}`,
          url_name: `fixture_item_${index + 1}`,
        },
      }));
      client.requestRaw = async () => ({
        res: {
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === "authorization" ? "JWT fixture-token" : null) },
          json: async () => ({}),
          text: async () => "",
        },
        body: { payload: { user: { ingame_name: "Fixture Account", platform: "pc" } } },
      });
      client.requestV2 = async (method, endpoint, options) => {
        if (method === "GET" && endpoint === "/orders/my") {
          const snapshot = structuredClone(orders);
          if (state.holdReads) {
            state.heldReads += 1;
            await new Promise<void>((resolve) => {
              state.releaseRead = resolve;
            });
          }
          return { data: snapshot };
        }
        if (method === "GET" && endpoint === "/me")
          return { data: { status: "online", ingameName: "Fixture Account" } };
        if (method === "PATCH") {
          const id = endpoint.split("/").at(-1)!;
          const body = options?.json as Record<string, unknown>;
          state.requests.push({ id, body });
          if (state.mode === "hold")
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          if (state.mode === "unauthorized")
            throw new WfmApiError("Fixture session expired", "WFM_UNAUTHORIZED", 401);
          if (state.mode === "partial" && id.endsWith("2"))
            throw new WfmApiError("Fixture service unavailable", "WFM_SERVER_ERROR", 503);
          const order = orders.find((entry) => entry.id === id);
          if (!order) throw new Error(`Unknown fixture order ${id}`);
          Object.assign(order, body);
          return { data: structuredClone(order) };
        }
        throw new Error(`Unexpected fixture request ${method} ${endpoint}`);
      };
      // Direct service sign-in avoids starting a live websocket for the fake account.
      await session.signIn("fixture@example.test", "fixture-password");
    });
    await harness.page.reload();
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expect(harness.page.locator(".order-row")).toHaveCount(3);
  });

  test.afterEach(async () => {
    try {
      if (harness)
        await evaluateInMain(harness.app, () => {
          const state = (globalThis as typeof globalThis & { repriceFixture: RepriceFixture })
            .repriceFixture;
          state.release?.();
          state.releaseRead?.();
        }).catch(() => {});
      expect(pageErrors).toEqual([]);
    } finally {
      await closeElectronTestHarness(harness);
    }
  });

  async function openPricedModal(): Promise<Locator> {
    const page = harness.page;
    await page.locator("[data-market-select-all]").first().click();
    await page.locator("[data-market-reprice]").click();
    const modal = page.locator("[data-reprice-modal]");
    await modal.locator("[data-reprice-strategy]").selectOption("match-cheapest");
    await modal.locator("[data-reprice-load]").click();
    await expect(modal.locator("[data-reprice-apply]")).toBeEnabled();
    await expect(modal.locator("[data-reprice-summary]")).toContainText("3");
    return modal;
  }

  async function setMode(mode: RepriceFixture["mode"]): Promise<void> {
    await evaluateInMain(
      harness.app,
      (_electron, next) => {
        (globalThis as typeof globalThis & { repriceFixture: RepriceFixture }).repriceFixture.mode =
          next;
      },
      mode,
    );
  }

  function requests() {
    return evaluateInMain(
      harness.app,
      () =>
        (globalThis as typeof globalThis & { repriceFixture: RepriceFixture }).repriceFixture
          .requests,
    );
  }

  async function expectPrices(prices: number[]): Promise<void> {
    for (const [index, price] of prices.entries()) {
      const row = harness.page
        .locator(".order-row")
        .filter({ has: harness.page.locator(`[data-order-edit="${fixtureId(index)}"]`) });
      await expect(row.locator('input[type="number"]').nth(1)).toHaveValue(String(price));
    }
  }

  test("Apply reconciles partial success and retries only the failed listing when selected", async () => {
    await setMode("partial");
    const modal = await openPricedModal();
    await modal.locator("[data-reprice-apply]").click();
    await expect(modal.locator("[data-reprice-failed]")).toHaveAttribute(
      "data-reprice-failed",
      "1",
    );
    await expect(modal.locator("[data-reprice-apply]")).toBeEnabled();
    expect((await requests()).map((request) => request.body)).toEqual([
      { platinum: 50, quantity: 1 },
      { platinum: 50, quantity: 2 },
      { platinum: 50, quantity: 3 },
    ]);
    await harness.page.keyboard.press("Escape");
    await expectPrices([50, 11, 50]);
    await setMode("success");
    await harness.page.locator("[data-market-reprice]").click();
    await modal.locator("[data-reprice-select-none]").click();
    await modal.locator(`[data-reprice-select="${fixtureId(1)}"]`).check();
    await modal.locator("[data-reprice-strategy]").selectOption("match-cheapest");
    await modal.locator("[data-reprice-load]").click();
    await expect(modal.locator("[data-reprice-apply]")).toBeEnabled();
    await modal.locator("[data-reprice-apply]").click();
    await expect.poll(async () => (await requests()).length).toBe(4);
    await expect(modal.locator("[data-reprice-apply]")).toBeEnabled();
    await harness.page.keyboard.press("Escape");
    await expectPrices([50, 50, 50]);
    expect((await requests()).at(-1)?.id).toBe(fixtureId(1));
    await harness.page.reload();
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expectPrices([50, 50, 50]);
  });

  test("closing during Apply keeps the in-flight success and sends no remaining listings", async () => {
    await setMode("hold");
    const modal = await openPricedModal();
    await modal.locator("[data-reprice-apply]").click();
    await expect.poll(async () => (await requests()).length).toBe(1);
    await harness.page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await evaluateInMain(harness.app, () => {
      const state = (globalThis as typeof globalThis & { repriceFixture: RepriceFixture })
        .repriceFixture;
      state.mode = "success";
      state.release?.();
    });
    await expectPrices([50, 11, 12]);
    expect((await requests()).map((request) => request.id)).toEqual([fixtureId(0)]);
    await harness.page.reload();
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expectPrices([50, 11, 12]);
  });

  test("a stale background refresh cannot overwrite the in-flight reprice success", async () => {
    await setMode("hold");
    const modal = await openPricedModal();
    await evaluateInMain(harness.app, () => {
      (
        globalThis as typeof globalThis & { repriceFixture: RepriceFixture }
      ).repriceFixture.holdReads = true;
    });
    await harness.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() =>
        evaluateInMain(
          harness.app,
          () =>
            (globalThis as typeof globalThis & { repriceFixture: RepriceFixture }).repriceFixture
              .heldReads,
        ),
      )
      .toBe(1);
    await modal.locator("[data-reprice-apply]").click();
    await expect.poll(async () => (await requests()).length).toBe(1);
    await harness.page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await evaluateInMain(harness.app, () => {
      const state = (globalThis as typeof globalThis & { repriceFixture: RepriceFixture })
        .repriceFixture;
      state.mode = "success";
      state.release?.();
    });
    await expectPrices([50, 11, 12]);
    await evaluateInMain(harness.app, () => {
      (
        globalThis as typeof globalThis & { repriceFixture: RepriceFixture }
      ).repriceFixture.releaseRead?.();
    });
    // A second background read starts only after the first stops blocking it.
    // Keep that response held so it cannot repair a stale overwrite.
    await expect
      .poll(async () => {
        await harness.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return evaluateInMain(
          harness.app,
          () =>
            (globalThis as typeof globalThis & { repriceFixture: RepriceFixture }).repriceFixture
              .heldReads,
        );
      })
      .toBe(2);
    await expectPrices([50, 11, 12]);
  });

  test("an expired session stops Apply at the first listing and clears the persisted login", async () => {
    await setMode("unauthorized");
    const modal = await openPricedModal();
    await modal.locator("[data-reprice-apply]").click();
    await expect(modal.locator("[data-reprice-stopped]")).toBeVisible();
    expect((await requests()).map((request) => request.id)).toEqual([fixtureId(0)]);
    expect(await harness.page.evaluate(() => window.api.wfmGetSession())).toMatchObject({
      loggedIn: false,
    });
    expect(fs.existsSync(path.join(harness.sandboxDir, "user-data", "wfm.session"))).toBe(false);
    await harness.page.keyboard.press("Escape");
    await expectPrices([10, 11, 12]);
    await harness.page.reload();
    await harness.page.locator('#sidebar [data-view="market"]').click();
    await expect(harness.page.locator("#market-email")).toBeVisible();
  });
});
