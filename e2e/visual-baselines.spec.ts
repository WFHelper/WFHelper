import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

test("Settings, feedback and overlay previews keep their reviewed appearance", async () => {
  test.skip(process.platform !== "win32", "Reviewed Windows font and Chromium baselines");
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-visual-baselines-", {
      storage: { wf_theme_settings: JSON.stringify({ preset: "default" }) },
      onPage: async (page) => {
        await page.route("**/renderer/fonts/**", (route) => route.abort());
        await page.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            const style = document.createElement("style");
            style.textContent = "* { font-family: Arial, sans-serif !important; }";
            document.head.append(style);
          });
        });
        await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"));
      },
    });
    const { page } = harness;
    await setLayoutViewport(page, 900, 1000);
    await openView(page, "settings");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("[data-settings-actions]")).toBeVisible();
    await expect(page.locator("[data-settings-actions]")).toHaveScreenshot("settings-actions.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.005,
    });
    await page.locator("#sidebar [data-feedback-open]").click();
    const modal = page.locator("[data-feedback-modal]");
    await expect(modal).toBeVisible();
    await expect(page.locator("[data-feedback-metadata]")).toBeVisible();
    await expect(modal).toHaveScreenshot("feedback.png", {
      animations: "disabled",
      mask: [page.locator("[data-feedback-metadata]")],
      maxDiffPixelRatio: 0.005,
    });
    await page.locator("[data-feedback-cancel]").click();
    await setLayoutViewport(page, 1280, 1000);
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="overlays"]').click();
    for (const kind of ["rivenLeft", "arbiSummary", "tradeNotification"]) {
      await page.locator(`[data-overlay-editor-open="${kind}"]`).click();
      const preview = page.locator("[data-reward-editor-frame]");
      const frame = await (await preview.elementHandle())?.contentFrame();
      if (!frame) throw new Error(`${kind} preview did not mount`);
      await expect(frame.locator("body")).toHaveClass(/reward-layout-editing/);
      await frame.evaluate(() => document.fonts.ready);
      await expect(preview).toHaveScreenshot(`${kind}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.005,
      });
      await page.locator("[data-reward-editor-save]").click();
      await expect(preview).toHaveCount(0);
    }
  } finally {
    await closeElectronTestHarness(harness);
  }
});
