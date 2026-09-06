import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const WORLD_QUERY = "popout=view:world";
// Vendor rotations come from a local rotation table plus the item database, so the
// strip renders with no world state and no network.
const VENDOR_WEAPON = "Tenet Ferrox";

const STATUS_BAR_BG = "rgb(9, 200, 11)";
const MODAL_BG = "rgb(12, 34, 210)";
const CONTENT_BG = "rgb(210, 34, 12)";

// Authored unscoped on purpose: the sanitizer prefixes #shell, and the status bar
// and the modal layer are siblings of #app that no author rule could reach before.
const CUSTOM_CSS = [
  `footer { background-color: ${STATUS_BAR_BG}; }`,
  `.detail-panel { background-color: ${MODAL_BG}; }`,
  `#content { background-color: ${CONTENT_BG}; }`,
].join("\n");

test.describe("Custom CSS reach", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-custom-css-e2e-", {
      storage: {
        wf_custom_css_v1: JSON.stringify({ enabled: true, css: CUSTOM_CSS, updatedAt: 1 }),
      },
    });
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function worldPopout(): Promise<Page> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = harness.app.windows().find((win) => win.url().includes(WORLD_QUERY));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("world popout window never appeared");
  }

  test("the sheet reaches the status bar and a detail modal", async () => {
    await expect(page.locator("#shell")).toHaveCount(1);
    await expect(page.locator("footer").first()).toHaveCSS("background-color", STATUS_BAR_BG);

    await openView(page, "world");
    const card = page.locator(`[data-vendor-weapon="${VENDOR_WEAPON}"] button`);
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.click();

    await expect(page.locator('[role="dialog"] .detail-panel').first()).toHaveCSS(
      "background-color",
      MODAL_BG,
    );

    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test("a popout window gets the sheet as well", async () => {
    await openView(page, "world");
    await page.locator("[data-popout-open]").click();

    const popout = await worldPopout();
    await expect(popout.locator("#shell")).toHaveCount(1);
    await expect(popout.locator("#content")).toHaveCSS("background-color", CONTENT_BG, {
      timeout: 90_000,
    });

    const card = popout.locator(`[data-vendor-weapon="${VENDOR_WEAPON}"] button`);
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.click();
    await expect(popout.locator('[role="dialog"] .detail-panel').first()).toHaveCSS(
      "background-color",
      MODAL_BG,
    );

    await popout.close();
    await expect
      .poll(() => harness.app.windows().filter((win) => win.url().includes(WORLD_QUERY)).length)
      .toBe(0);
  });
});
