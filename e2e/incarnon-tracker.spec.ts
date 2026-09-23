import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

test("incarnon tracker is its own mastery tab and remembers it", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  const pageErrors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-incarnon-tab-", {
      onPage: (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
      },
    });
    const { page } = harness;
    await setLayoutViewport(page, 1440, 900);
    await openView(page, "mastery");

    const viewTabs = page.locator('[data-tour="mastery-view-tabs"]');
    const incarnonTab = viewTabs.locator('[data-tour-tab="incarnon"]');
    const tracker = page.locator("[data-incarnon-tracker]");

    await viewTabs.locator('[data-tour-tab="collection"]').click();
    await expect(tracker).toHaveCount(0);

    await incarnonTab.click();
    await expect(incarnonTab).toHaveAttribute("data-active", "true");
    await expect(tracker).toBeVisible();
    await expect(page.locator("[data-incarnon-card]").first()).toBeVisible({ timeout: 90_000 });
    await expect(tracker.locator(".world-section-toggle")).toHaveCount(0);
    await expect(page.locator("[data-mastery-grid]")).toHaveCount(0);
    await expect(page.locator("[data-mastery-summary]")).toHaveCount(0);

    const widths = await page.evaluate(() => {
      const bar = document.querySelector('[data-tour="mastery-view-tabs"]');
      const panel = document.querySelector("[data-incarnon-tracker]");
      if (!bar || !panel) throw new Error("mastery tab bar or incarnon tracker is missing");
      return { bar: bar.getBoundingClientRect().width, panel: panel.getBoundingClientRect().width };
    });
    expect(Math.abs(widths.bar - widths.panel)).toBeLessThanOrEqual(1);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("incarnon-tab.png"),
    });

    // The seeded inventory owns nothing, so no weapon is unlocked.
    const unlocked = tracker.locator('[data-incarnon-filter="unlocked"]');
    await unlocked.click();
    await expect(unlocked).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-incarnon-card]")).toHaveCount(0);

    await page.reload();
    await openView(page, "mastery");
    await expect(incarnonTab).toHaveAttribute("data-active", "true");
    await expect(unlocked).toHaveAttribute("aria-pressed", "true");

    await viewTabs.locator('[data-tour-tab="collection"]').click();
    await expect(tracker).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    if (harness) await closeElectronTestHarness(harness);
  }
});
