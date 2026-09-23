import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  setLayoutViewport,
} from "./electronTestHarness";

test("documentation links open the overview and the matching guides", async () => {
  const parts = [
    "BratonPrimeBarrel",
    "BratonPrimeReceiver",
    "BratonPrimeStock",
    "BroncoPrimeBarrel",
    "BroncoPrimeReceiver",
    "LexPrimeBarrel",
    "LexPrimeReceiver",
    "BurstonPrimeBarrel",
    "BurstonPrimeReceiver",
    "BurstonPrimeStock",
  ];
  const harness = await launchElectronTestHarness("wf-docs-links-", {
    inventory: {
      Suits: [],
      MiscItems: parts.map((part, index) => ({
        ItemType: `/Lotus/Types/Recipes/Weapons/WeaponParts/${part}`,
        ItemCount: (index % 5) + 1,
      })),
    },
    storage: { wf_inventory_tab: "all_parts" },
  });
  try {
    const { page, app } = harness;
    await evaluateInMain(app, ({ app, shell }) => {
      Object.defineProperty(app, "isPackaged", { value: true });
      const state = globalThis as unknown as { docsOpenedUrls: string[] };
      state.docsOpenedUrls = [];
      shell.openExternal = async (url) => {
        state.docsOpenedUrls.push(url);
      };
    });
    await page.reload();
    await setLayoutViewport(page, 1440, 960);
    await page.locator('#sidebar [data-view="inventory"]').click();
    const inventoryHelp = page.locator('[data-docs-link="inventory"]');
    await expect(inventoryHelp).toHaveAttribute("title", "Inventory help");
    await inventoryHelp.click();
    await page.screenshot({ path: test.info().outputPath("inventory-help.png") });

    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="about"]').click();
    const overview = page.locator('[data-docs-link="overview"]');
    await overview.scrollIntoViewIfNeeded();
    await expect(overview).toHaveAccessibleName("Documentation");
    await overview.click();
    await page.screenshot({ path: test.info().outputPath("settings-docs.png") });

    await page.evaluate(() => {
      localStorage.removeItem("setup-completed-v2");
      localStorage.setItem("app-language", "de");
    });
    await page.reload();
    const setupHelp = page.locator('[data-docs-link="setup"]');
    await expect(setupHelp).toHaveAttribute("title", /^Hilfe zu /);
    await setupHelp.focus();
    await page.keyboard.press("Enter");
    await page.screenshot({ path: test.info().outputPath("setup-help-de.png") });

    const expected = [
      "https://wfhelper.com/docs/inventory",
      "https://wfhelper.com/docs/",
      "https://wfhelper.com/docs/getting-started",
    ];
    await expect
      .poll(() =>
        evaluateInMain(
          app,
          () => (globalThis as unknown as { docsOpenedUrls: string[] }).docsOpenedUrls,
        ),
      )
      .toEqual(expected);
    for (const slug of ["inventory", "getting-started"]) {
      expect(fs.existsSync(path.resolve("docs/features", `${slug}.md`))).toBe(true);
    }
    await page.evaluate(() => localStorage.setItem("app-language", "en"));
    await page.reload();
    await expect(page.locator('[data-docs-link="setup"]')).toHaveAttribute("title", "Setup help");
    await page.screenshot({ path: test.info().outputPath("setup-help.png") });
  } finally {
    await closeElectronTestHarness(harness);
  }
});
