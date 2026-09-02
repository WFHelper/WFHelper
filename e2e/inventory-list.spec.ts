import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const PART_PREFIX = "/Lotus/Types/Recipes/Weapons/WeaponParts/";
// Tradable parts resolve a market slug locally, so the rows carry their real
// labels with no network. Two families so a search can cut the list in half.
const PARTS = [
  "AcceltraPrimeBarrel",
  "AcceltraPrimeReceiver",
  "AcceltraPrimeStock",
  "BratonPrimeBarrel",
  "BratonPrimeReceiver",
  "BratonPrimeStock",
  "BoltorPrimeBarrel",
  "BoltorPrimeReceiver",
  "BoltorPrimeStock",
  "BurstonPrimeBarrel",
  "BurstonPrimeReceiver",
  "BurstonPrimeStock",
];

function inventory(): unknown {
  return {
    Suits: [],
    MiscItems: PARTS.map((part) => ({ ItemType: PART_PREFIX + part, ItemCount: 2 })),
  };
}

test.describe("Inventory list view", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-inventory-list-", { inventory: inventory() });
    page = harness.page;
    await openView(page, "inventory");
    await page.locator('[data-tour-tab="all_parts"]').click();
    await expect(page.locator(".item-card").first()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  function modeButton(mode: "cards" | "list") {
    return page.locator(`[data-inventory-view-mode-option="${mode}"]`);
  }

  // The Cards/Rows switch lives in Settings > Appearance, so every mode change is
  // a round trip. The settings tab resets to General on each mount.
  async function openAppearanceSettings(): Promise<void> {
    await openView(page, "settings");
    await page.locator('[data-tour-tab="appearance"]').click();
    await expect(page.locator("[data-inventory-view-mode]")).toBeVisible({ timeout: 15_000 });
  }

  async function setMode(mode: "cards" | "list"): Promise<void> {
    await openAppearanceSettings();
    await modeButton(mode).click();
    await expect(modeButton(mode)).toHaveAttribute("aria-pressed", "true");
    await openView(page, "inventory");
  }

  function searchBox() {
    return page.locator(".view-sticky-filters .shared-filter-search input");
  }

  async function setSearch(value: string): Promise<void> {
    await searchBox().fill(value);
    await page.waitForTimeout(300);
  }

  test.beforeEach(async () => {
    await setMode("cards");
    await setSearch("");
    await expect(page.locator(".item-card").first()).toBeVisible({ timeout: 15_000 });
  });

  test("the setting swaps the card grid for a table and back", async () => {
    await setMode("list");
    await expect(page.locator("[data-inventory-list]")).toBeVisible();
    await expect(page.locator(".item-card")).toHaveCount(0);

    await setMode("cards");
    await expect(page.locator("[data-inventory-list]")).toHaveCount(0);
    await expect(page.locator(".item-card").first()).toBeVisible();
  });

  test("both modes show the same rows under one filter", async () => {
    await setSearch("braton");
    const cardCount = await page.locator(".item-card").count();
    expect(cardCount).toBeGreaterThan(0);
    expect(cardCount).toBeLessThan(PARTS.length);

    await setMode("list");
    await expect(page.locator("[data-list-row]").first()).toBeVisible();
    expect(await page.locator("[data-list-row]").count()).toBe(cardCount);

    // Widening the filter has to move both renderers by the same amount.
    await setSearch("prime");
    const listCount = await page.locator("[data-list-row]").count();
    await setMode("cards");
    await expect(page.locator(".item-card").first()).toBeVisible();
    expect(await page.locator(".item-card").count()).toBe(listCount);
  });

  test("the chosen mode survives a reload", async () => {
    await setMode("list");
    await expect(page.locator("[data-inventory-list]")).toBeVisible();

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "inventory");
    await expect(page.locator("[data-inventory-list]")).toBeVisible({ timeout: 30_000 });

    await openAppearanceSettings();
    await expect(modeButton("list")).toHaveAttribute("aria-pressed", "true");
  });

  test("a column header writes the shared sort store", async () => {
    await setMode("list");
    await expect(page.locator("[data-inventory-list]")).toBeVisible();

    const sortSelect = page.locator(".view-sticky-filters .sort-control-select");
    await expect(sortSelect).toHaveValue("name");

    await page.locator('[data-list-sort="platinum"]').click();
    await expect(sortSelect).toHaveValue("platinum");
    await expect(page.locator('[data-list-column="platinum"]')).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    // Re-clicking the active column flips it instead of restarting the sort.
    await page.locator('[data-list-sort="platinum"]').click();
    await expect(sortSelect).toHaveValue("platinum");
    await expect(page.locator('[data-list-column="platinum"]')).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  test("a row click opens the item detail modal", async () => {
    await setSearch("braton prime barrel");
    await setMode("list");
    const row = page.locator("[data-list-row]").first();
    await expect(row).toBeVisible();

    await row.click();
    await expect(page.locator(".detail-header h2")).toHaveText(/Braton Prime Barrel/i, {
      timeout: 15_000,
    });
    await page.locator(".detail-close").click();
    await expect(page.locator(".detail-header")).toHaveCount(0);
  });
});
