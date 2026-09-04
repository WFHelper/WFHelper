import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELTRA = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";

test.describe("Feature tour", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;
  const cspErrors: string[] = [];

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-feature-tour-e2e-", {
      storage: {
        wf_tab_visible_foundry: "0",
        wf_inventory_tab: "resources",
        wf_mastery_view_tab: "roadmap",
        wf_mastery_roadmap_tab: "platinum",
        wf_relics_tab: "Axi",
        wf_market_tab: "buy",
        wf_rivens_tab: "finder",
        "world-tab": "world",
      },
    });
    page = harness.page;
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /content security policy|style-src|inline style/i.test(message.text())
      ) {
        cspErrors.push(message.text());
      }
    });
    writeHarnessInventory(harness, {
      Suits: [],
      LongGuns: [{ ItemType: ACCELTRA, XP: 450_000 }],
      XPInfo: [{ ItemType: ACCELTRA, XP: 450_000 }],
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("walks every available step without replacing saved sub-tabs", async () => {
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator("[data-tour-restart]").click();

    const card = page.locator("[data-tour-card]");
    const next = card.locator("[data-tour-next]");

    await expect(card).toBeVisible();
    await expect
      .poll(() => card.evaluate((node) => node.getBoundingClientRect().width))
      .toBeCloseTo(380, 0);
    expect(cspErrors).toEqual([]);

    async function expectStep(position: number, text: string): Promise<void> {
      await expect(card).toContainText(`${position} / 16`);
      await expect(card).toContainText(text);
      await expect(card).toHaveAttribute("data-tour-target-matched", "true", {
        timeout: 5_000,
      });
    }

    await expectStep(1, "Inventory shows");
    await expect(
      page.locator('[data-tour="inventory-tabs"] [data-tour-tab="all_parts"]'),
    ).toHaveAttribute("data-active", "true");

    await next.click();
    await expectStep(2, "Use these tabs to switch item types");
    await next.click();
    await expectStep(3, "Mastery tracks");
    await expect(
      page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="collection"]'),
    ).toHaveAttribute("data-active", "true");

    await next.click();
    await expectStep(4, "Press Ctrl+F");
    await next.click();
    await expectStep(5, "MR Roadmap suggests");
    await expect(
      page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="roadmap"]'),
    ).toHaveAttribute("data-active", "true");
    await expect(
      page.locator('[data-tour="mastery-roadmap"] [data-tour-tab="platinum"]'),
    ).toHaveAttribute("data-active", "true");
    await page.locator('[data-tour="mastery-roadmap"] [data-tour-tab="relics"]').click();

    const remainingSteps = [
      "Stats tracks resources",
      "World shows cycles",
      "Filter the arbitration schedule",
      "Relics can show your collection",
      "View and manage your warframe.market orders",
      "Browse shows public buy and sell orders",
      "Use these tabs for unveiled Rivens",
      "Arbitration and Profit-Taker runs are recorded automatically",
      "Search for an item",
      "Configure the relic",
      "Choose which tabs",
    ];

    for (const [offset, text] of remainingSteps.entries()) {
      await next.click();
      await expectStep(offset + 6, text);
      if (text.startsWith("Use these tabs")) {
        await expect(
          page.locator('[data-tour="riven-view-tabs"] [data-tour-tab="unveiled"]'),
        ).toHaveAttribute("data-active", "true");
      }
      if (text.startsWith("Relics can")) {
        await expect(page.locator('[data-relic-tier-tabs] [data-tour-tab="Axi"]')).toHaveAttribute(
          "data-active",
          "true",
        );
        await page.locator('[data-relic-tier-tabs] [data-tour-tab="Lith"]').click();
      }
    }

    // Last step: the same Next button reads Done and closes the card.
    await card.locator("[data-tour-next]").click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          inventory: localStorage.getItem("wf_inventory_tab"),
          mastery: localStorage.getItem("wf_mastery_view_tab"),
          roadmap: localStorage.getItem("wf_mastery_roadmap_tab"),
          relics: localStorage.getItem("wf_relics_tab"),
          market: localStorage.getItem("wf_market_tab"),
          rivens: localStorage.getItem("wf_rivens_tab"),
          world: localStorage.getItem("world-tab"),
        })),
      )
      .toEqual({
        inventory: "resources",
        mastery: "roadmap",
        roadmap: "platinum",
        relics: "Axi",
        market: "buy",
        rivens: "finder",
        world: "world",
      });

    await page.locator('#sidebar [data-view="market"]').click();
    await expect(page.locator('#content [data-tour-tab="buy"]')).toHaveAttribute(
      "data-active",
      "true",
    );
    await page.locator('#sidebar [data-view="relics"]').click();
    await expect(page.locator('[data-relic-tier-tabs] [data-tour-tab="Axi"]')).toHaveAttribute(
      "data-active",
      "true",
    );
    await page.locator('#sidebar [data-view="mastery"]').click();
    await expect(
      page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="roadmap"]'),
    ).toHaveAttribute("data-active", "true");
    await expect(
      page.locator('[data-tour="mastery-roadmap"] [data-tour-tab="platinum"]'),
    ).toHaveAttribute("data-active", "true");

    for (const exit of ["skip", "escape"] as const) {
      await page.locator('#sidebar [data-view="settings"]').click();
      await page.locator("[data-tour-restart]").click();
      await expect(card).toBeVisible();
      if (exit === "escape") await page.keyboard.press("Escape");
      else await card.locator("[data-tour-skip]").click();
      await expect(card).toHaveCount(0);
      await expect(
        page.locator('[data-tour="inventory-tabs"] [data-tour-tab="resources"]'),
      ).toHaveAttribute("data-active", "true");
      expect(
        await page.evaluate(() => [
          localStorage.getItem("wf_inventory_tab"),
          localStorage.getItem("wf_mastery_view_tab"),
          localStorage.getItem("wf_mastery_roadmap_tab"),
          localStorage.getItem("wf_relics_tab"),
          localStorage.getItem("wf_market_tab"),
          localStorage.getItem("wf_rivens_tab"),
          localStorage.getItem("world-tab"),
        ]),
      ).toEqual(["resources", "roadmap", "platinum", "Axi", "buy", "finder", "world"]);
    }

    expect(cspErrors).toEqual([]);
  });
});
