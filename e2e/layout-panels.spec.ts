import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { ArbiRunRecord } from "../config/shared/arbiTypes";
import type { TradeEvent } from "../config/shared/statsTypes";
import type { TopTradedDoc } from "../config/shared/topTraded";
import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  LAYOUT_SCALES,
  LAYOUT_SIZES,
  openView,
  setFontScale,
  setWindowSize,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Scrollbars here are painted over the content (::-webkit-scrollbar is 6px wide
// and takes no layout width), so a gutter has to beat the bar, not clientWidth.
const SCROLLBAR_WIDTH = 6;

interface FixtureOrder {
  id: string;
  orderType: string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  itemId: string;
  itemName: string;
  itemUrlName: string;
  itemThumb: string | null;
}

function fixtureOrders(): { sell: FixtureOrder[]; buy: FixtureOrder[] } {
  // Order ids must satisfy the IPC validator's 24-hex WFM ObjectId shape.
  const sell = Array.from({ length: 8 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(24, "0"),
    orderType: "sell",
    platinum: 10 + index * 9,
    quantity: 1 + (index % 3),
    visible: true,
    modRank: null,
    itemId: `fixture-item-${index + 1}`,
    itemName: `Fixture Item ${index + 1}`,
    itemUrlName: `fixture_item_${index + 1}`,
    itemThumb: null,
  }));
  return { sell, buy: [] };
}

// Enough rows that the panel's max-h-[26rem] box has to scroll at every scale.
const TOP_TRADED: TopTradedDoc = {
  generatedAt: Date.now() - 60_000,
  windowDays: 7,
  items: Array.from({ length: 24 }, (_, index) => ({
    slug: `fixture_traded_${index + 1}`,
    name: `Fixture Traded Item ${index + 1}`,
    volume: 400 - index * 7,
    median: 20 + index * 9,
    value: (400 - index * 7) * (20 + index * 9),
  })),
  byValue: [],
};

const LEDGER: TradeEvent[] = Array.from({ length: 12 }, (_, index) => ({
  id: `layout-${index}`,
  date: `2026-09-${String(index + 10)}T20:48:00.000Z`,
  type: "sale",
  platChange: 200,
  items: [
    {
      internalName: "",
      displayName: `Fixture Trade Item ${index}`,
      count: 1,
      direction: "given",
    },
  ],
  partner: `Partner${String(index + 10)}`,
}));

const RUN_START = new Date(2026, 8, 8, 12).getTime();
const ARBI_RUN: ArbiRunRecord = {
  id: "2026-09-08_12-00-00",
  startedAt: RUN_START,
  endedAt: RUN_START + 149_000,
  missionName: "Arbitration: Stofler Defense (Lua)",
  node: "Stofler (Lua)",
  missionType: "defense",
  durationSec: 149,
  rotations: 2,
  drones: 3,
  totalEnemies: 240,
  vitusActual: null,
  logFile: null,
  logSizeBytes: 0,
  endReason: "imported",
  source: "imported",
  stats: null,
};

// A recorded run keeps its log, so its row carries both action buttons.
const LIVE_RUN_START = new Date(2026, 8, 9, 18, 30).getTime();
const LIVE_ARBI_RUN: ArbiRunRecord = {
  ...ARBI_RUN,
  id: "2026-09-09_18-30-00",
  startedAt: LIVE_RUN_START,
  endedAt: LIVE_RUN_START + 1_845_000,
  missionName: "Arbitration: Cerberus Interception (Pluto)",
  node: "Cerberus (Pluto)",
  missionType: "interception",
  durationSec: 1845,
  rotations: 12,
  drones: 148,
  vitusActual: 14,
  logFile: "2026-09-09_18-30-00.log.gz",
  logSizeBytes: 1_234_567,
  endReason: "mission-end",
  source: "live",
};

test.describe("Panels hold their layout on a small window at a raised text scale", () => {
  test.setTimeout(300_000);

  let harness: ElectronTestHarness;
  let page: Page;
  let fixtureDir: string;

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-layout-panels-fx-"));
    const fixturePath = path.join(fixtureDir, "wfm-orders.json");
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureOrders()));
    harness = await launchElectronTestHarness("wfh-layout-panels-", {
      env: { WFHELPER_WFM_FIXTURES: fixturePath },
      userDataFiles: {
        "trade-log.json": LEDGER,
        "arbi-runs.json": { schemaVersion: 1, runs: [LIVE_ARBI_RUN, ARBI_RUN] },
      },
      // A fresh stored copy answers loadTopTraded() without any request.
      storage: {
        wf_top_traded_v1: JSON.stringify({ savedAt: Date.now(), etag: null, doc: TOP_TRADED }),
      },
    });
    page = harness.page;
  });

  test.afterAll(async () => {
    try {
      await closeElectronTestHarness(harness);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("top traded keeps the scrollbar off its right-aligned columns", async () => {
    for (const scale of LAYOUT_SCALES) {
      await setFontScale(page, scale);
      for (const size of LAYOUT_SIZES) {
        await setWindowSize(harness, size.width, size.height);
        await openView(page, "analytics");
        const box = page.locator("[data-analysis-top-traded-scroll]");
        await expect(box).toBeVisible({ timeout: 30_000 });
        await box.screenshot({
          path: test.info().outputPath(`top-traded-${size.width}-${scale}.png`),
        });

        const measured = await box.evaluate((element: HTMLElement) => {
          const cells = Array.from(
            element.querySelectorAll<HTMLElement>("[data-analysis-top-traded-value]"),
          );
          const right = element.getBoundingClientRect().right;
          return {
            cells: cells.length,
            scrolls: element.scrollHeight > element.clientHeight,
            gutter: Math.min(...cells.map((cell) => right - cell.getBoundingClientRect().right)),
            reserved: element.offsetWidth - element.clientWidth,
          };
        });

        const at = `${size.width}px, ${scale}x`;
        expect(measured.cells, `no value cells at ${at}`).toBeGreaterThan(0);
        expect(measured.scrolls, `the seeded rows must overflow the panel at ${at}`).toBe(true);
        expect(measured.gutter, `values run under the scrollbar at ${at}`).toBeGreaterThanOrEqual(
          Math.max(SCROLLBAR_WIDTH, measured.reserved),
        );
      }
    }
  });

  test("a sell order's stepper stays clear of the row actions", async () => {
    for (const scale of LAYOUT_SCALES) {
      await setFontScale(page, scale);
      for (const size of LAYOUT_SIZES) {
        await setWindowSize(harness, size.width, size.height);
        await openView(page, "market");
        await expect(page.locator("[data-order-actions]").first()).toBeVisible({ timeout: 30_000 });

        const measured = await page.evaluate(() => {
          const covered: string[] = [];
          let checked = 0;
          for (const row of Array.from(document.querySelectorAll<HTMLElement>(".order-row"))) {
            const stepper = row.querySelector<HTMLElement>("[data-order-price-stepper]");
            const actions = row.querySelector<HTMLElement>("[data-order-actions]");
            if (!stepper || !actions) continue;
            checked += 1;
            const a = stepper.getBoundingClientRect();
            const b = actions.getBoundingClientRect();
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (overlapX > 0.5 && overlapY > 0.5) {
              covered.push(
                row.querySelector("[data-order-edit]")?.getAttribute("data-order-edit") ?? "row",
              );
            }
          }
          return { checked, covered };
        });

        const at = `${size.width}px, ${scale}x`;
        expect(measured.checked, `no compact sell rows at ${at}`).toBeGreaterThan(0);
        expect(measured.covered, `the actions cover the stepper at ${at}`).toEqual([]);
      }
    }

    await setFontScale(page, 1);
    for (const size of LAYOUT_SIZES) {
      await setWindowSize(harness, size.width, size.height);
      await openView(page, "market");
      await expect(page.locator("[data-order-price-stepper]").first()).toBeVisible({
        timeout: 30_000,
      });
      const wrapped = await page.evaluate(() => {
        let rows = 0;
        let broken = 0;
        // The quantity and price groups are the wrap row's children; the
        // groups' own parts sit centred at different heights, so measure the row.
        for (const stepper of Array.from(
          document.querySelectorAll<HTMLElement>("[data-order-price-stepper]"),
        )) {
          const tops = Array.from(stepper.parentElement?.children ?? []).map(
            (child) => child.getBoundingClientRect().top,
          );
          if (tops.length < 2) continue;
          rows += 1;
          if (Math.max(...tops) - Math.min(...tops) > 2) broken += 1;
        }
        return { rows, broken };
      });
      expect(wrapped.rows, `no stepper rows at ${size.width}px, 1x`).toBeGreaterThan(0);
      expect(wrapped.broken, `a stepper wrapped at ${size.width}px, 1x`).toBe(0);
    }
  });

  test("the runs table fits inside its card", async () => {
    for (const scale of LAYOUT_SCALES) {
      await setFontScale(page, scale);
      for (const size of LAYOUT_SIZES) {
        await setWindowSize(harness, size.width, size.height);
        await openView(page, "arbi");
        const list = page.locator("[data-arbi-run-table]");
        await expect(list).toBeVisible({ timeout: 30_000 });
        await expect(list.locator("tbody tr")).toHaveCount(2);
        await list.screenshot({
          path: test.info().outputPath(`runs-table-${size.width}-${scale}.png`),
        });

        const measured = await list.evaluate((element) => {
          const cells = Array.from(element.querySelectorAll<HTMLElement>("th, td"));
          const box = element.getBoundingClientRect();
          const actions = Array.from(element.querySelectorAll<HTMLElement>("tbody button"));
          return {
            cells: cells.length,
            overflow: element.scrollWidth - element.clientWidth,
            // A column squeezed under its longest unbreakable word clips it;
            // wrapping does not, so this only catches unreadable strips.
            clipped: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
            actions: actions.length,
            actionsOutside: actions.filter((button) => {
              const rect = button.getBoundingClientRect();
              return rect.left < box.left - 1 || rect.right > box.left + element.clientWidth + 1;
            }).length,
          };
        });

        const at = `${size.width}px, ${scale}x`;
        expect(measured.cells, `the runs table is empty at ${at}`).toBeGreaterThan(9);
        expect(measured.overflow, `the runs table scrolls sideways at ${at}`).toBeLessThanOrEqual(
          1,
        );
        expect(measured.clipped, `a runs column cuts its own text at ${at}`).toBe(0);
        expect(measured.actions, `the run actions are missing at ${at}`).toBe(3);
        expect(measured.actionsOutside, `a run action sits outside the card at ${at}`).toBe(0);
      }
    }
  });

  test("a trade row shows its partner name at a raised scale", async () => {
    for (const scale of LAYOUT_SCALES) {
      await setFontScale(page, scale);
      for (const size of LAYOUT_SIZES) {
        await setWindowSize(harness, size.width, size.height);
        await openView(page, "stats");
        await page.locator('[data-tour-tab="tracking"]').click();
        await expect(page.locator("[data-stats-trade-panel]")).toBeVisible({ timeout: 30_000 });
        const partner = page.locator("[data-trade-partner]").first();
        await expect(partner).toBeVisible({ timeout: 30_000 });

        const measured = await partner.evaluate((element) => ({
          text: element.textContent?.trim() ?? "",
          clipped: element.scrollWidth > element.clientWidth + 1,
          width: element.getBoundingClientRect().width,
        }));

        const at = `${size.width}px, ${scale}x`;
        expect(measured.text, `the partner name is not whole at ${at}`).toMatch(/^Partner\d\d$/);
        expect(measured.clipped, `the partner name is cut off at ${at}`).toBe(false);
        expect(measured.width, `the partner span has no width at ${at}`).toBeGreaterThan(0);
      }
    }
  });

  test("the collapsed rail shows most of its destinations", async () => {
    for (const scale of LAYOUT_SCALES) {
      await setFontScale(page, scale);
      for (const size of LAYOUT_SIZES) {
        await setWindowSize(harness, size.width, size.height);
        await page.locator("#sidebar [data-sidebar-collapse]").click();
        await expect(page.locator("#sidebar")).toHaveClass(/sidebar-collapsed/);
        await page.waitForTimeout(200);
        await page.locator("#sidebar").screenshot({
          path: test.info().outputPath(`sidebar-collapsed-${size.width}-${scale}.png`),
        });

        const rail = await page.evaluate(() => {
          const sidebar = document.querySelector<HTMLElement>("#sidebar");
          const nav = document.querySelector<HTMLElement>("[data-sidebar-nav]");
          if (!sidebar || !nav) throw new Error("the sidebar rail is missing");
          const scroller = nav.scrollHeight > nav.clientHeight ? nav : sidebar;
          const view = scroller.getBoundingClientRect();
          const rects = Array.from(sidebar.querySelectorAll<HTMLElement>("[data-view]")).map(
            (button) => button.getBoundingClientRect(),
          );
          const whole = rects.filter(
            (r) => r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5,
          );
          return {
            total: rects.length,
            whole: whole.length,
            lastBottom: whole.length > 0 ? whole[whole.length - 1]!.bottom : 0,
            viewBottom: view.bottom,
          };
        });

        await page.locator("#sidebar [data-sidebar-collapse]").click();
        await expect(page.locator("#sidebar")).not.toHaveClass(/sidebar-collapsed/);

        const at = `${size.width}px, ${scale}x`;
        expect(rail.total, `no nav buttons at ${at}`).toBeGreaterThan(9);
        expect(rail.whole, `the collapsed rail hides its destinations at ${at}`).toBeGreaterThan(4);
        if (size.width === 1366 && scale === 1.25) {
          expect(rail.whole, "the collapsed rail at 1366x728, 1.25x").toBeGreaterThanOrEqual(9);
        }
      }
    }
  });
});
