import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const WORLD_QUERY = "popout=view:world";
// Vendor rotations come from a local rotation table plus the item database, so
// the strip renders with no world state and no network. The attribute holds the
// English rotation-table name, which is what makes it locale-independent.
const VENDOR_WEAPON = "Tenet Ferrox";

test.describe("Popout detail modals", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-popout-modal-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function worldWindow(): Promise<Page> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = harness.app.windows().find((win) => win.url().includes(WORLD_QUERY));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("world popout window never appeared");
  }

  test("an item clicked in a World popout opens the detail modal in that window", async () => {
    await openView(page, "world");
    await page.locator("[data-popout-open]").click();

    const popout = await worldWindow();
    const card = popout.locator(`[data-vendor-weapon="${VENDOR_WEAPON}"] button`);
    await expect(card).toBeVisible({ timeout: 90_000 });

    await card.click();

    await expect(popout.locator('[role="dialog"]')).toBeVisible();
    // The stores are per-window, so the click must not open anything in main.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    await popout.keyboard.press("Escape");
    await expect(popout.locator('[role="dialog"]')).toHaveCount(0);

    await popout.close();
    await expect
      .poll(() => harness.app.windows().filter((win) => win.url().includes(WORLD_QUERY)).length)
      .toBe(0);
  });
});
