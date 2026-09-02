import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const SECTION_ID = "stats.charts";
const SECTION_QUERY = "popout=section:stats.charts";
const WORKSPACE_KEY = "wf_workspaces_v1";

// Stats is the cheapest wrapped view to drive: both of its sections render with
// no inventory, no world state and no network.
test.describe("Section popouts and workspaces", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-popout-section-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function sectionWindow(): Promise<Page> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = harness.app.windows().find((win) => win.url().includes(SECTION_QUERY));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("section popout window never appeared");
  }

  async function openSectionPopout(): Promise<Page> {
    await openView(page, "stats");
    await page.locator(`[data-layout-popout="${SECTION_ID}"]`).first().click();
    return sectionWindow();
  }

  test("the section control opens a window showing only that section", async () => {
    const popout = await openSectionPopout();

    await expect(popout.locator("[data-popout-section]")).toHaveAttribute(
      "data-popout-section",
      SECTION_ID,
    );
    const sections = popout.locator("[data-layout-section]");
    await expect(sections).toHaveCount(1);
    await expect(sections).toHaveAttribute("data-layout-section", SECTION_ID);
    // The window is the section, so it never offers to pop itself out again.
    await expect(popout.locator("[data-layout-popout]")).toHaveCount(0);

    await popout.close();
    await expect
      .poll(() => harness.app.windows().filter((win) => win.url().includes(SECTION_QUERY)).length)
      .toBe(0);
  });

  test("a workspace saves the open windows and reopens them after a reload", async () => {
    const popout = await openSectionPopout();
    await expect(popout.locator("[data-layout-section]")).toHaveCount(1);

    await openView(page, "settings");
    await page.locator('[data-tour-tab="customization"]').click();
    await page.locator("[data-workspace-name]").fill("Charts window");
    await page.locator("[data-workspace-save]").click();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), WORKSPACE_KEY))
      .toContain("Charts window");

    // Close the window, then prove Apply brings the same target back.
    await page.locator("[data-workspace-close-all]").click();
    await expect
      .poll(() => harness.app.windows().filter((win) => win.url().includes(SECTION_QUERY)).length)
      .toBe(0);

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "settings");
    await page.locator('[data-tour-tab="customization"]').click();

    const row = page.locator("[data-workspace-row]").first();
    await expect(row).toBeVisible();
    await row.locator("[data-workspace-apply]").click();

    const restored = await sectionWindow();
    await expect(restored.locator("[data-layout-section]")).toHaveCount(1);

    await page.locator("[data-workspace-close-all]").click();
    await expect
      .poll(() => harness.app.windows().filter((win) => win.url().includes(SECTION_QUERY)).length)
      .toBe(0);
  });
});
