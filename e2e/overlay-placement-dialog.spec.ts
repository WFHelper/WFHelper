import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Settings opens the setup placement mockup without a game. The trade toast is
// driven through main because no trade can happen here.
test.describe.serial("Overlay placement dialog", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-overlay-placement-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  const dialog = () => page.locator("[data-overlay-placement-dialog]");

  async function openDialog(): Promise<void> {
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="overlay"]').click();
    await page.locator("[data-open-overlay-placement]").click();
    await expect(dialog()).toBeVisible();
    await expect(dialog().locator("[data-placement-dummy]").first()).toBeVisible({
      timeout: 30_000,
    });
  }

  async function savedTradeBounds(): Promise<{ x: number; y: number } | undefined> {
    return (await page.evaluate(() => window.api.getOverlaySettings())).overlayWindowBounds
      .tradeNotification;
  }

  test("opens on the first overlay and closes by button and by Escape", async () => {
    await openDialog();
    await expect(dialog().locator('[data-placement-step="reward"]')).toBeVisible();
    await expect(dialog().getByText("1 / 5")).toBeVisible();
    await expect(dialog().getByRole("slider")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("placement-dialog.png"),
      animations: "disabled",
    });

    await dialog().locator("[data-overlay-placement-close]").click();
    await expect(dialog()).toHaveCount(0);

    await openDialog();
    await page.keyboard.press("Escape");
    await expect(dialog()).toHaveCount(0);
  });

  test("the trade toast step saves where the real toast then appears", async () => {
    expect(await savedTradeBounds()).toBeUndefined();
    await openDialog();
    for (let step = 0; step < 4; step += 1) {
      await dialog().locator("[data-setup-overlay-next]").click();
    }
    await expect(dialog().locator('[data-placement-step="tradeNotification"]')).toBeVisible();
    await expect(dialog().getByText("5 / 5")).toBeVisible();
    await expect(dialog().getByRole("slider")).toHaveCount(0);

    const dummy = dialog().locator('[data-placement-dummy="tradeNotification"]');
    const before = await dummy.boundingBox();
    expect(before).not.toBeNull();
    // The toast starts in the top-right corner, so the drag goes down and left.
    await page.mouse.move(before!.x + before!.width / 2, before!.y + 8);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2 - 120, before!.y + 88, { steps: 8 });
    await page.mouse.up();
    const after = await dummy.boundingBox();
    expect(after!.x).toBeLessThan(before!.x);
    expect(after!.y).toBeGreaterThan(before!.y);
    await page.screenshot({
      path: test.info().outputPath("placement-dialog-trade.png"),
      animations: "disabled",
    });

    await expect.poll(savedTradeBounds).toMatchObject({ x: expect.any(Number) });
    const saved = (await savedTradeBounds())!;

    // On the last step the primary button finishes and closes the dialog.
    await dialog().locator("[data-setup-overlay-next]").click();
    await expect(dialog()).toHaveCount(0);

    await evaluateInMain(harness.app, ({ app }) => {
      const moduleApi = process.getBuiltinModule("module") as {
        createRequire: (filename: string) => (id: string) => Record<string, unknown>;
      };
      const load = moduleApi.createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const show = load("./ipc/tradeNotificationIpc.js").showTradeNotification;
      if (typeof show !== "function") throw new Error("missing showTradeNotification");
      show(
        {
          kind: "order",
          orderId: "placement-order",
          itemName: "Braton Prime Receiver",
          itemUrlName: "braton_prime_receiver",
          itemThumb: null,
          quantity: 1,
          platinum: 42,
          partner: "Tenno",
          type: "sale",
        },
        "closed",
      );
    });

    await expect
      .poll(() =>
        evaluateInMain(harness.app, ({ BrowserWindow }) => {
          const toast = BrowserWindow.getAllWindows().find((win) =>
            win.webContents.getURL().includes("trade-notification.html"),
          );
          return toast ? toast.getBounds() : null;
        }),
      )
      .toMatchObject({ x: saved.x, y: saved.y });
  });
});
