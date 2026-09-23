import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LAYOUT_KEY = "wf_layout_v1";
const WIDGET = '[data-widget="widget.lastMission"]';
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const OROKIN_CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const SUMMARIES = [
  {
    id: "newest",
    endedAt: NOW,
    readAt: NOW + 20_000,
    missionCount: 1,
    missionType: "MT_SURVIVAL",
    node: "SolNode25",
    items: [
      { uniqueName: FORMA_BP, count: 1 },
      { uniqueName: PLASTIDS, count: 240 },
    ],
    credits: 12_345,
    endo: 400,
  },
  {
    id: "older",
    endedAt: NOW - 600_000,
    readAt: NOW - 580_000,
    missionCount: 2,
    missionType: "MT_EXTERMINATION",
    items: [{ uniqueName: OROKIN_CELL, count: 3 }],
    credits: 0,
    endo: 0,
  },
  {
    id: "oldest",
    endedAt: NOW - 1_200_000,
    readAt: NOW - 1_180_000,
    missionCount: 1,
    items: [],
    credits: 0,
    endo: 0,
  },
];

// Every dashboard section that existed before the mission widget, in the stored shape.
const SAVED_SECTIONS = [
  "cycles",
  "fissures",
  "foundryReady",
  "marketAlerts",
  "goals",
  "baro",
  "inventoryValue",
  "tradeSummary",
  "recentRuns",
].map((name) => ({
  id: `dashboard.${name}`,
  span: name === "recentRuns" ? "full" : 1,
  hidden: false,
  collapsed: false,
}));

test.describe("Last mission widget", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-last-mission-e2e-", {
      userDataFiles: {
        "mission-rewards.json": SUMMARIES,
        "overlay-settings.json": { missionTrackingEnabled: true },
      },
    });
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function openDashboard(): Promise<void> {
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "dashboard");
    await expect(page.locator('[data-layout-grid="dashboard"]')).toBeVisible({ timeout: 30_000 });
  }

  test("a fresh dashboard shows the newest mission with totals", async () => {
    await page.evaluate((key) => localStorage.removeItem(key), LAYOUT_KEY);
    await openDashboard();

    const widget = page.locator(WIDGET);
    await expect(widget).toHaveCount(1);
    await expect(widget.locator("[data-reward-row]")).toHaveCount(2);
    await expect(widget.locator('[data-reward-total="credits"] dd')).toHaveText("12,345");
    await expect(widget.locator('[data-reward-total="endo"] dd')).toHaveText("400");
    await expect(widget.locator("[data-last-mission-type]")).toHaveText(/survival/i);
    await expect(widget.locator("[data-last-mission-node]")).not.toHaveText("");
    await widget.screenshot({ path: test.info().outputPath("last-mission-newest.png") });
  });

  test("the picker switches between stored missions", async () => {
    await openDashboard();
    const widget = page.locator(WIDGET);
    const picker = widget.locator("[data-last-mission-picker] select");
    await expect(picker.locator("option")).toHaveCount(3);

    await picker.selectOption("older");
    await expect(widget.locator(`[data-reward-row="${OROKIN_CELL}"]`)).toHaveCount(1);
    await expect(widget.locator("[data-last-mission-count]")).toBeVisible();

    await picker.selectOption("oldest");
    await expect(widget.locator("[data-last-mission-nothing]")).toBeVisible();
    await widget.screenshot({ path: test.info().outputPath("last-mission-nothing.png") });
  });

  test("clicking a reward opens its item popup", async () => {
    await openDashboard();
    await page.locator(`${WIDGET} [data-reward-row="${FORMA_BP}"] button`).first().click();
    await expect(page.locator('[role="dialog"] [data-item-detail]')).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("the view-all link opens the Missions tab", async () => {
    await openDashboard();
    await page.locator(`${WIDGET} [data-last-mission-view-all]`).click();
    await expect(page.locator("[data-missions-view]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-missions-latest]")).toHaveAttribute(
      "data-missions-latest",
      "newest",
    );
  });

  test("a dashboard layout saved before the widget existed stays as it was", async () => {
    await page.evaluate(
      ([key, sections]) => {
        const layout = { version: 1, sections };
        localStorage.setItem(
          key as string,
          JSON.stringify({ version: 1, views: { dashboard: { narrow: layout, wide: layout } } }),
        );
      },
      [LAYOUT_KEY, SAVED_SECTIONS] as const,
    );
    await openDashboard();
    await expect(page.locator(WIDGET)).toHaveCount(0);
  });
});
