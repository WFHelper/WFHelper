import { test, expect, type Page } from "@playwright/test";

import { DB_GET_WORLD_STATE } from "../config/shared/ipcChannels";
import type { WorldState } from "../src/types/world";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LAYOUT_KEY = "wf_layout_v1";
const DASHBOARD_KEY = "wf_dashboard_v1";

// Normal (not Steel Path, not railjack) fissures, because the widget follows the
// World tab's mode filter and that store defaults to "normal".
function fissureWorld(now: number): WorldState {
  return {
    fissures: ["Lith", "Meso", "Omnia"].map((tier, index) => ({
      id: `fissure-${tier.toLowerCase()}`,
      tier,
      node: `Node ${tier}`,
      missionType: "Survival",
      expiry: new Date(now + 21_600_000 + index * 60_000).toISOString(),
      expired: false,
      isHard: false,
      isStorm: false,
    })),
  };
}

const WIDGET_IDS = [
  "widget.cycles",
  "widget.fissures",
  "widget.foundryReady",
  "widget.marketAlerts",
  "widget.goals",
  "widget.baro",
  "widget.inventoryValue",
  "widget.tradeSummary",
  "widget.lastMission",
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
    expect(await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY)).toBeNull();
  });

  test("every widget offers a link to its own tab", async () => {
    for (const id of WIDGET_IDS) {
      await expect(page.locator(`[data-widget-open="${id}"]`)).toHaveCount(1);
    }
    await page.locator('[data-widget-open="widget.cycles"]').click();
    await expect(page.locator("#content")).toHaveAttribute("data-view", "world");
  });

  test("every widget header leads with its home tab's icon", async () => {
    for (const id of WIDGET_IDS) {
      await expect(page.locator(`[data-widget="${id}"] header img`)).toHaveCount(1);
    }
  });

  test("an empty widget says where its data comes from", async () => {
    const empties = page.locator("[data-widget-empty]");
    await expect.poll(() => empties.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await empties.count()); index += 1) {
      await expect(empties.nth(index).locator("[data-widget-open-empty]")).toHaveCount(1);
    }
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
    await expect(page.locator('[data-layout-chrome="dashboard.cycles"]')).toHaveCount(0);

    await page.locator('[data-layout-edit-toggle="dashboard"]').click();
    await page.locator('[data-layout-restore="dashboard.baro"]').click();
    await expect(page.locator('[data-widget="widget.baro"]')).toHaveCount(1);
  });

  test("a widget setting is edited through the gear and persisted", async () => {
    await page.locator('[data-layout-edit-toggle="dashboard"]').click();
    await page.locator('[data-widget-gear="widget.fissures"]').click();

    const input = page.locator(
      '[data-widget-settings="widget.fissures"] [data-widget-setting="limit"]',
    );
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

  // Last in the file: the stubbed world-state handler outlives the test.
  test("hiding a fissure tier drops only that tier's rows and is persisted", async () => {
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, fixture) => {
        ipcMain.removeHandler(fixture.channel);
        ipcMain.handle(fixture.channel, () => fixture.world);
      },
      { world: fissureWorld(Date.now()), channel: DB_GET_WORLD_STATE },
    );
    await reload();
    await openView(page, "dashboard");

    const row = (tier: string) =>
      page.locator(`[data-widget="widget.fissures"] [data-fissure-tier="${tier}"]`);
    await expect(row("lith")).toHaveCount(1);
    await expect(row("meso")).toHaveCount(1);
    await expect(row("omnia")).toHaveCount(1);

    await page.locator('[data-layout-edit-toggle="dashboard"]').click();
    await page.locator('[data-widget-gear="widget.fissures"]').click();
    const lith = page.locator(
      '[data-widget-settings="widget.fissures"] [data-widget-setting="lith"]',
    );
    await expect(lith).toBeChecked();
    await lith.uncheck();

    await expect(row("lith")).toHaveCount(0);
    await expect(row("meso")).toHaveCount(1);
    await expect(row("omnia")).toHaveCount(1);

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as {
            widgets: { id: string; settings?: { lith?: boolean; meso?: boolean } }[];
          };
          const settings = parsed.widgets.find((w) => w.id === "widget.fissures")?.settings;
          return settings ? [settings.lith, settings.meso] : null;
        }, DASHBOARD_KEY),
      )
      .toEqual([false, true]);
  });
});
