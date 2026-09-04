import { test, expect, type Page } from "@playwright/test";

// The view draws one card per generated row, so the table is the expected count.
import { SYNDICATE_RANKS } from "../src/data/syndicateRanks";
import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const GALLIUM = "/Lotus/Types/Items/MiscItems/Gallium";

// Each test is self-contained: a failed test restarts the worker, which re-runs
// beforeAll with a fresh sandbox and empty localStorage.
test.describe("Syndicate rank-up assistant", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-syndicates-e2e-");
    page = harness.page;
    // Rank 1 with one Gallium leaves the rank 2 Forma and the rank 3 Gallium short.
    writeHarnessInventory(harness, {
      PlayerLevel: 20,
      RegularCredits: 5000,
      DailyAffiliation: 2000,
      Affiliations: [{ Tag: "ArbitersSyndicate", Standing: 10000, Title: 1, Initiated: true }],
      MiscItems: [{ ItemType: GALLIUM, ItemCount: 1 }],
      Suits: [],
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  const card = () => page.locator('[data-syndicate-card="ArbitersSyndicate"]');

  test.beforeEach(async () => {
    await page.evaluate(() => localStorage.removeItem("wf_syndicate_goals_v1"));
    await openView(page, "syndicates");
  });

  test("the sidebar opens the tab and lists every syndicate", async () => {
    await expect(page.locator("[data-syndicates-view]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-syndicate-card]")).toHaveCount(SYNDICATE_RANKS.length);
    await expect(card()).toBeVisible();
  });

  test("picking a target rank lists what is still missing", async () => {
    await expect(card()).toBeVisible({ timeout: 30_000 });
    await expect(card().locator("[data-syndicate-missing]")).toHaveCount(0);

    await card().locator('[data-syndicate-goal="3"]').click();

    await expect(card().locator('[data-syndicate-step="2"]')).toBeVisible();
    await expect(card().locator('[data-syndicate-step="3"]')).toBeVisible();
    await expect(card().locator("[data-syndicate-missing]").first()).toBeVisible();

    const totals = page.locator("[data-syndicates-totals]");
    await expect(totals.locator("[data-syndicate-total-item]")).toHaveCount(2);
    await expect(totals.locator('[data-syndicate-pool="NORMAL"]')).toBeVisible();
  });

  test("a goal survives a renderer reload and clears on demand", async () => {
    await card().locator('[data-syndicate-goal="2"]').click();
    await expect(card().locator('[data-syndicate-step="2"]')).toBeVisible();

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "syndicates");
    await expect(card().locator('[data-syndicate-step="2"]')).toBeVisible();

    await page.locator("[data-syndicates-view] .view-header button").last().click();
    await expect(card().locator("[data-syndicate-step]")).toHaveCount(0);
  });
});
