import { test, expect, type Page } from "@playwright/test";

import { MISSION_REWARDS_RECENT_LIMIT } from "../config/shared/missionRewardsTypes";
import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const PERIOD_KEY = "wf_missions_period";
const LAYOUT_KEY = "wf_layout_v1";
const WIDGET = '[data-widget="widget.lastMission"]';
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const OROKIN_CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;

interface SeedSummary {
  id: string;
  endedAt: number;
  readAt: number;
  missionCount: number;
  missionType: string;
  node?: string;
  items: { uniqueName: string; count: number }[];
  credits: number;
  endo: number;
}

function seed(id: string, endedAt: number, missionType: string, cells: number): SeedSummary {
  return {
    id,
    endedAt,
    readAt: endedAt + 20_000,
    missionCount: 1,
    missionType,
    items: [
      { uniqueName: PLASTIDS, count: 10 },
      ...(cells > 0 ? [{ uniqueName: OROKIN_CELL, count: cells }] : []),
    ],
    credits: 1_000,
    endo: 10,
  };
}

// The widget picker shows a batch of two missions and one that brought nothing.
const WEEK_OVERRIDES: Record<number, Partial<SeedSummary>> = {
  0: { missionCount: 2 },
  1: { items: [], credits: 0, endo: 0 },
};

// Newest first, as the 2.x widget stored them: 2 today, 8 this week, 50 older.
const SUMMARIES: SeedSummary[] = [
  {
    ...seed("newest", NOW - MINUTE, "MT_SURVIVAL", 0),
    node: "SolNode25",
    items: [
      { uniqueName: FORMA_BP, count: 1 },
      { uniqueName: PLASTIDS, count: 240 },
    ],
    credits: 12_345,
    endo: 400,
  },
  seed("today-2", NOW - 5 * MINUTE, "MT_DEFENSE", 3),
  ...Array.from({ length: 8 }, (_, i) => ({
    ...seed(`week-${i}`, NOW - (2 + (i % 4)) * DAY, i % 2 ? "MT_DEFENSE" : "MT_SURVIVAL", 0),
    ...WEEK_OVERRIDES[i],
  })),
  ...Array.from({ length: 50 }, (_, i) =>
    seed(`old-${i}`, NOW - (40 + i) * DAY, "MT_EXTERMINATION", i === 0 ? 1 : 0),
  ),
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

test.describe("Missions view", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-missions-view-e2e-", {
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

  async function openMissions(): Promise<void> {
    await page.evaluate((key) => localStorage.setItem(key, "all"), PERIOD_KEY);
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "missions");
    await expect(page.locator("[data-missions-view]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-missions-list]")).toBeVisible({ timeout: 30_000 });
  }

  async function openDashboard(): Promise<void> {
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "dashboard");
    await expect(page.locator('[data-layout-grid="dashboard"]')).toBeVisible({ timeout: 30_000 });
  }

  function missionsTile(): ReturnType<Page["locator"]> {
    return page.locator('[data-missions-totals] [data-reward-total="missions"] dd');
  }

  test("shows the latest mission and the migrated history", async () => {
    await openMissions();
    const latest = page.locator("[data-missions-latest]");
    await expect(latest).toHaveAttribute("data-missions-latest", "newest");
    await expect(latest.locator("[data-reward-row]")).toHaveCount(2);
    await expect(latest.locator('[data-reward-total="credits"] dd')).toHaveText("12,345");
    await expect(page.locator("[data-missions-recorded]")).toHaveAttribute(
      "data-missions-recorded",
      "60",
    );
    // The tile counts missions, so the batch of two adds one over the 60 records.
    await expect(missionsTile()).toHaveText("61");
    await expect(page.locator("[data-mission-entry]")).toHaveCount(50);
    await page.screenshot({ path: test.info().outputPath("missions-all.png") });
  });

  test("pages through every recorded mission", async () => {
    await openMissions();
    await page.locator("[data-missions-more] button").click();
    await expect(page.locator("[data-mission-entry]")).toHaveCount(60);
    await expect(page.locator("[data-missions-more]")).toHaveCount(0);
  });

  test("periods, mission type and item search narrow the list and the totals", async () => {
    await openMissions();

    await page.locator('[data-missions-periods] [data-tour-tab="today"]').click();
    await expect(page.locator("[data-mission-entry]")).toHaveCount(2);
    await expect(missionsTile()).toHaveText("2");

    await page.locator('[data-missions-periods] [data-tour-tab="7d"]').click();
    await expect(page.locator("[data-mission-entry]")).toHaveCount(10);

    await page.locator("[data-missions-type-filter]").selectOption("MT_DEFENSE");
    await expect(page.locator("[data-mission-entry]")).toHaveCount(5);

    await page.locator("[data-missions-type-filter]").selectOption("");
    await page.locator('[data-missions-periods] [data-tour-tab="all"]').click();
    await page.locator("[data-missions-search] input").fill("orokin");
    await expect(page.locator("[data-mission-entry]")).toHaveCount(2);
    await expect(page.locator('[data-mission-entry="today-2"]')).toHaveCount(1);
    await expect(page.locator('[data-mission-entry="old-0"]')).toHaveCount(1);

    await page.locator("[data-missions-search] input").fill("no item is called this");
    await expect(page.locator("[data-missions-no-match]")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("missions-no-match.png") });
  });

  test("a mission expands to its rewards and a reward opens its item popup", async () => {
    await openMissions();
    await page.locator('[data-mission-toggle="newest"]').click();
    const detail = page.locator('[data-mission-detail="newest"]');
    await expect(detail.locator("[data-reward-row]")).toHaveCount(2);
    await page.locator("[data-missions-items-toggle]").click();
    await page.screenshot({ path: test.info().outputPath("missions-expanded.png") });
    await detail.locator(`[data-reward-row="${FORMA_BP}"] button`).click();
    await expect(page.locator('[role="dialog"] [data-item-detail]')).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test.describe("Last mission widget", () => {
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
      await expect(picker.locator("option")).toHaveCount(MISSION_REWARDS_RECENT_LIMIT);

      await picker.selectOption("today-2");
      await expect(widget.locator(`[data-reward-row="${OROKIN_CELL}"]`)).toHaveCount(1);

      await picker.selectOption("week-0");
      await expect(widget.locator("[data-last-mission-count]")).toBeVisible();

      await picker.selectOption("week-1");
      await expect(widget.locator("[data-last-mission-nothing]")).toBeVisible();
      await widget.screenshot({ path: test.info().outputPath("last-mission-nothing.png") });
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

  // Last: it switches tracking off for the rest of this harness.
  test("with tracking off the tab says so, keeps the history and links to the setting", async () => {
    await openMissions();
    await expect(page.locator('[data-missions-status="tracking-off"]')).toHaveCount(0);

    await openView(page, "settings");
    await page.locator('#content [data-tour-tab="general"]').click();
    const toggle = page.locator('[data-setting="missionTracking"] input[type="checkbox"]');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();

    await openView(page, "missions");
    await expect(page.locator('[data-missions-status="tracking-off"]')).toBeVisible();
    await expect(page.locator("[data-missions-latest]")).toHaveAttribute(
      "data-missions-latest",
      "newest",
    );
    await page.screenshot({ path: test.info().outputPath("missions-tracking-off.png") });

    await page.locator("[data-missions-view] [data-mission-tracking-settings]").click();
    await expect(page.locator('[data-settings-panel="general"]')).toBeVisible();
    await expect(page.locator('[data-settings-section="missions"]')).toBeInViewport();
    await expect(toggle).not.toBeChecked();
  });
});
