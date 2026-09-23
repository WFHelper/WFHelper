import { expect, test, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  dragRange,
  launchElectronTestHarness,
  openView,
  releaseRange,
  setFontScale,
  setWindowSize,
  type ElectronTestHarness,
} from "./electronTestHarness";

function measureRelicRow(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-relic-filter-row]");
    const tabs = document.querySelector<HTMLElement>("[data-relic-tier-tabs]");
    const search = document.querySelector<HTMLElement>("[data-relic-filter-controls] .search-box");
    if (!row || !tabs || !search) throw new Error("relic filter row is missing");
    const tabsRect = tabs.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    return {
      overlaps:
        Math.min(tabsRect.right, searchRect.right) - Math.max(tabsRect.left, searchRect.left) >
          0.5 &&
        Math.min(tabsRect.bottom, searchRect.bottom) - Math.max(tabsRect.top, searchRect.top) > 0.5,
      searchEscapesRow: searchRect.left < row.getBoundingClientRect().left - 0.5,
      rowFits: row.scrollWidth <= row.clientWidth,
    };
  });
}

function measureNavIcons(page: Page) {
  return page.evaluate(() => {
    const icons = Array.from(document.querySelectorAll<HTMLElement>("#sidebar [data-view] img"));
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("#sidebar [data-view]"));
    return {
      sizes: icons.map((icon) => {
        const rect = icon.getBoundingClientRect();
        return `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`;
      }),
      pitch:
        buttons.length > 1
          ? +(
              buttons[1]!.getBoundingClientRect().top - buttons[0]!.getBoundingClientRect().top
            ).toFixed(1)
          : 0,
    };
  });
}

function measureAppearanceCards(page: Page) {
  return page.evaluate(() => {
    const sections = [
      { selector: "[data-app-scale]", cards: "label", rowInside: false },
      { selector: "[data-font-sizes]", cards: "label", rowInside: false },
      { selector: "[data-style-section]", cards: ":scope > .grid > div", rowInside: true },
    ];
    return sections.map(({ selector, cards: cardSelector, rowInside }) => {
      const section = document.querySelector<HTMLElement>(selector);
      if (!section) throw new Error(`${selector} is missing`);
      const cards = Array.from(section.querySelectorAll<HTMLElement>(cardSelector));
      if (cards.length === 0) throw new Error(`${selector} has no card`);
      return {
        selector,
        sectionOverflow: section.scrollWidth - section.clientWidth,
        cardOverflow: Math.max(...cards.map((card) => card.scrollWidth - card.clientWidth)),
        stacked: cards.filter((card) => {
          const row = rowInside ? (card.firstElementChild as HTMLElement) : card;
          const label = row.firstElementChild!.getBoundingClientRect();
          const control = row.lastElementChild!.getBoundingClientRect();
          return control.top >= label.bottom - 1;
        }).length,
      };
    });
  });
}

async function openAppearance(page: Page): Promise<void> {
  await openView(page, "settings");
  await page.locator('[data-tour-tab="appearance"]').click();
  await page.locator('[data-appearance-tab="theme"]').click();
  await expect(page.locator("[data-app-scale]")).toBeVisible();
}

// Enough trades that the Stats trade rail has to scroll on a 728px window.
const LEDGER_ROWS = Array.from({ length: 10 }, (_, index) => ({
  id: `scale-${index}`,
  date: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
  type: "sale",
  platChange: 10 + index,
  items: [
    {
      internalName: "",
      displayName: `Fixture Trade Item ${index}`,
      count: 1,
      direction: "given",
    },
  ],
  partner: `Partner${index}`,
}));

test.describe("Layout holds at a raised text scale", () => {
  test.setTimeout(300_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-text-scale-layout-", {
      userDataFiles: { "trade-log.json": LEDGER_ROWS },
    });
    page = harness.page;
    await setWindowSize(harness, 1920, 1200);
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("relic tier tabs never sit under the filter controls", async () => {
    for (const scale of [1.25, 1.5]) {
      await setFontScale(page, scale);
      for (const width of [1200, 1600, 1920, 2560]) {
        await setWindowSize(harness, width, 1000);
        await openView(page, "relics");
        const layout = await measureRelicRow(page);
        await page
          .locator("[data-relic-filter-row]")
          .screenshot({ path: test.info().outputPath(`relics-${width}-${scale}.png`) });

        expect(layout.overlaps, `search box covers the tier tabs at ${width}px, ${scale}x`).toBe(
          false,
        );
        expect(layout.searchEscapesRow, `search box left the row at ${width}px, ${scale}x`).toBe(
          false,
        );
        expect(layout.rowFits, `filter row scrolls sideways at ${width}px, ${scale}x`).toBe(true);
      }
    }
    await setWindowSize(harness, 1920, 1200);
  });

  test("collapsed nav icons keep the size they have expanded", async () => {
    for (const scale of [1.25, 1.5]) {
      await setFontScale(page, scale);
      await setWindowSize(harness, 1920, 1200);
      const expanded = await measureNavIcons(page);
      await page.locator("#sidebar").screenshot({
        path: test.info().outputPath(`sidebar-expanded-${scale}.png`),
      });

      await page.locator("#sidebar [data-sidebar-collapse]").click();
      await expect(page.locator("#sidebar")).toHaveClass(/sidebar-collapsed/);
      const collapsed = await measureNavIcons(page);
      await page.locator("#sidebar").screenshot({
        path: test.info().outputPath(`sidebar-collapsed-${scale}.png`),
      });
      await page.locator("#sidebar [data-sidebar-collapse]").click();

      expect(expanded.sizes.length, `no nav icons at ${scale}x`).toBeGreaterThan(3);
      expect(collapsed.sizes, `collapsed nav icons shrink at ${scale}x`).toEqual(expanded.sizes);
      expect(collapsed.pitch, `collapsed nav rows change rhythm at ${scale}x`).toBe(expanded.pitch);
    }
  });

  test("the app size and font size cards fit their column", async () => {
    for (const scale of [1.25, 1.5]) {
      await setFontScale(page, scale);
      await setWindowSize(harness, 1920, 1200);
      await openAppearance(page);
      await page
        .locator("[data-app-scale]")
        .screenshot({ path: test.info().outputPath(`app-size-card-${scale}.png`) });

      for (const section of await measureAppearanceCards(page)) {
        expect(section.sectionOverflow, `${section.selector} overflows at ${scale}x`).toBe(0);
        expect(section.cardOverflow, `${section.selector} card overflows at ${scale}x`).toBe(0);
      }
    }
  });

  test("the text size controls apply on release", async () => {
    await setFontScale(page, 1.25);
    await setWindowSize(harness, 1920, 1200);
    await openAppearance(page);
    const rootSize = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    const percentBox = page.locator("[data-font-sizes] input[type='number']").first();
    const slider = page.locator("[data-font-sizes] input[type='range']").first();
    const scaled = await rootSize();

    await percentBox.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("12");
    expect(await rootSize(), "typing in the percent box re-scaled the page").toBe(scaled);
    await page.keyboard.press("Enter");
    expect(await rootSize(), "the percent box did not apply on Enter").not.toBe(scaled);
    await expect(percentBox, "the clamped value was not written back").toHaveValue("75");

    await setFontScale(page, 1.25);
    await openAppearance(page);
    await dragRange(slider, 1.5);
    expect(await rootSize(), "dragging the slider re-scaled the page").toBe(scaled);
    await expect(percentBox, "the slider did not update its live label").toHaveValue("150");
    await releaseRange(slider);
    expect(await rootSize(), "releasing the slider did not apply the scale").not.toBe(scaled);
  });

  test("the status bar keeps its update pill inside the window", async () => {
    for (const scale of [1, 1.25, 1.5]) {
      await setFontScale(page, scale);
      await setWindowSize(harness, 1366, 728);
      const box = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>("[data-status-bar]");
        const pill = document.querySelector<HTMLElement>(".update-pill");
        if (!bar || !pill) throw new Error("status bar or update pill is missing");
        const barRect = bar.getBoundingClientRect();
        const pillRect = pill.getBoundingClientRect();
        return {
          barHeight: barRect.height,
          overflow: Math.max(pillRect.bottom - barRect.bottom, barRect.top - pillRect.top),
          belowWindow: pillRect.bottom - window.innerHeight,
        };
      });
      expect(box.overflow, `pill leaves the bar at ${scale}x`).toBeLessThanOrEqual(0.5);
      expect(box.belowWindow, `pill leaves the window at ${scale}x`).toBeLessThanOrEqual(0.5);
      if (scale === 1) expect(Math.round(box.barHeight), "1x bar height").toBe(28);
    }
    await setWindowSize(harness, 1920, 1200);
  });

  test("the stats trade rail scrolls instead of running past its row", async () => {
    await setFontScale(page, 1.5);
    await setWindowSize(harness, 1366, 728);
    await openView(page, "stats");
    await page.locator('[data-tour-tab="tracking"]').click();
    await expect(page.locator("[data-stats-trade-panel]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-trade-row]").first()).toBeVisible({ timeout: 30_000 });
    const box = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("[data-stats-tracking]");
      const panel = document.querySelector<HTMLElement>("[data-stats-trade-panel]");
      const list = document.querySelector<HTMLElement>("[data-stats-trade-list]");
      if (!row || !panel || !list) throw new Error("stats tracking layout is missing");
      const rowRect = row.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        overflow: panelRect.bottom - rowRect.bottom,
        belowWindow: panelRect.bottom - window.innerHeight,
        listScrolls: list.scrollHeight > list.clientHeight,
      };
    });
    expect(box.overflow, "rail runs past its row").toBeLessThanOrEqual(0.5);
    expect(box.belowWindow, "rail runs past the window").toBeLessThanOrEqual(0.5);
    expect(box.listScrolls, "the seeded trades must overflow the rail").toBe(true);
    await setWindowSize(harness, 1920, 1200);
  });

  test("the cards stay on one line at the default text scale", async () => {
    await setFontScale(page, 1);
    for (const width of [1400, 1920]) {
      await setWindowSize(harness, width, 1200);
      await openAppearance(page);
      for (const section of await measureAppearanceCards(page)) {
        expect(section.stacked, `${section.selector} wrapped at 1x, ${width}px`).toBe(0);
        expect(section.sectionOverflow, `${section.selector} overflows at 1x, ${width}px`).toBe(0);
      }
    }
    await setWindowSize(harness, 1920, 1200);
  });
});
