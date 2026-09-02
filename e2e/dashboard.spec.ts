import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LAYOUT_KEY = "wf_layout_v1";
const DASHBOARD_KEY = "wf_dashboard_v1";

// Every widget reads a store that exists with no inventory and no world state,
// so the grid renders on a cold sandbox; the panels are empty, not absent.
const WIDGET_IDS = [
  "widget.cycles",
  "widget.fissures",
  "widget.foundryReady",
  "widget.marketAlerts",
  "widget.goals",
  "widget.baro",
  "widget.inventoryValue",
  "widget.tradeSummary",
  "widget.recentRuns",
];

test.describe("Dashboard", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-dashboard-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  function sections(): Promise<string[]> {
    return page
      .locator('[data-layout-grid="dashboard"] [data-layout-section]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-layout-section") ?? ""));
  }

  async function reload(): Promise<void> {
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
  }

  test.beforeEach(async () => {
    await page.evaluate(
      ([layout, dashboard]) => {
        localStorage.removeItem(layout as string);
        localStorage.removeItem(dashboard as string);
      },
      [LAYOUT_KEY, DASHBOARD_KEY],
    );
    await reload();
    await openView(page, "dashboard");
    await expect(page.locator('[data-layout-grid="dashboard"]')).toBeVisible({ timeout: 30_000 });
  });

  test("the sidebar leads with the dashboard row", async () => {
    const first = await page.locator("#sidebar [data-view]").first().getAttribute("data-view");
    expect(first).toBe("dashboard");
  });

  test("renders every registered widget in its default order", async () => {
    for (const id of WIDGET_IDS) {
      await expect(page.locator(`[data-widget="${id}"]`)).toHaveCount(1);
    }
    expect(await sections()).toEqual(WIDGET_IDS.map((id) => id.replace("widget.", "dashboard.")));
    // Nothing is stored until the user actually edits something.
    expect(await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY)).toBeNull();
  });

  test("every widget offers a link to its own tab", async () => {
    for (const id of WIDGET_IDS) {
      await expect(page.locator(`[data-widget-open="${id}"]`)).toHaveCount(1);
    }
    await page.locator('[data-widget-open="widget.cycles"]').click();
    await expect(page.locator("#content")).toHaveAttribute("data-view", "world");
  });

  test("hiding a widget in edit mode survives a renderer reload", async () => {
    const toggle = page.locator('[data-layout-edit-toggle="dashboard"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await page.locator('[data-layout-hide="dashboard.baro"]').click();
    await expect(page.locator('[data-widget="widget.baro"]')).toHaveCount(0);
    await expect.poll(sections).not.toContain("dashboard.baro");

    await reload();
    await openView(page, "dashboard");
    await expect(page.locator('[data-layout-grid="dashboard"]')).toBeVisible({ timeout: 30_000 });
    await expect.poll(sections).not.toContain("dashboard.baro");
    // Edit mode is session state; the reload must not leave the chrome behind.
    await expect(page.locator('[data-layout-chrome="dashboard.cycles"]')).toHaveCount(0);

    await page.locator('[data-layout-edit-toggle="dashboard"]').click();
    await page.locator('[data-layout-restore="dashboard.baro"]').click();
    await expect(page.locator('[data-widget="widget.baro"]')).toHaveCount(1);
  });

  test("a widget setting is edited through the gear and persisted", async () => {
    await page.locator('[data-layout-edit-toggle="dashboard"]').click();
    await page.locator('[data-widget-gear="widget.fissures"]').click();

    const input = page.locator('[data-widget-settings="widget.fissures"] [data-widget-setting]');
    await expect(input).toHaveValue("5");
    await input.fill("8");
    await input.blur();

    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), DASHBOARD_KEY))
      .toContain("widget.fissures");
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as {
            widgets: { id: string; settings?: { limit?: number } }[];
          };
          return parsed.widgets.find((w) => w.id === "widget.fissures")?.settings?.limit ?? null;
        }, DASHBOARD_KEY),
      )
      .toBe(8);
  });

  test("a stored dashboard from another build still lists every widget", async () => {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [
        DASHBOARD_KEY,
        JSON.stringify({
          version: 1,
          widgets: [
            { id: "widget.workshop2", span: 1, hidden: false, settings: { limit: 3 } },
            { id: "widget.fissures", span: 1, hidden: false, settings: { limit: "nope" } },
          ],
        }),
      ],
    );
    await reload();
    await openView(page, "dashboard");
    await expect(page.locator('[data-layout-grid="dashboard"]')).toBeVisible({ timeout: 30_000 });

    for (const id of WIDGET_IDS) {
      await expect(page.locator(`[data-widget="${id}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-widget="widget.workshop2"]')).toHaveCount(0);
  });
});
