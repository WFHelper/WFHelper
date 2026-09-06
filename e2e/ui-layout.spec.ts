import { test, expect, type Locator, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELTRA = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
const ADVANCES_DEBT_BOND = "/Lotus/Types/Items/Solaris/DebtTokenD";

function testInventory(resourceCount = 1) {
  return {
    Suits: [],
    LongGuns: [{ ItemType: ACCELTRA, XP: 450_000 }],
    MiscItems: [{ ItemType: ADVANCES_DEBT_BOND, ItemCount: resourceCount }],
    XPInfo: [{ ItemType: ACCELTRA, XP: 450_000 }],
  };
}

/** The filter selects carry no data attribute and their labels are translated,
 *  so the ownership one is identified by its option values. */
async function relicOwnershipSelect(page: Page): Promise<Locator> {
  const selects = page.locator("[data-relic-filter-controls] select");
  await expect(selects.first()).toBeVisible();
  const index = await selects.evaluateAll((nodes) =>
    nodes.findIndex((node) => {
      const values = Array.from((node as HTMLSelectElement).options, (option) => option.value);
      return values.length === 2 && values[0] === "owned" && values[1] === "all";
    }),
  );
  expect(index, "relic ownership select not found").toBeGreaterThanOrEqual(0);
  return selects.nth(index);
}

async function openRelics(page: Page, width: number): Promise<void> {
  await setLayoutViewport(page, width, 900);
  await openView(page, "relics");
  // Ownership "all" also switches the quality mode off "owned", so the strip
  // carries intact values instead of the owned-only placeholders.
  await (await relicOwnershipSelect(page)).selectOption("all");
  await expect(page.locator(".relic-compact-card").first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(400);
}

/**
 * The metric strip is nowrap, so a column that may shrink under it pushes the
 * numbers out to the left across the name column, where the status tag sits.
 */
async function measureRelicCards(page: Page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".relic-compact-card"));
    let worstSpill = 0;
    let narrowestCard: number | null = null;
    let narrowestName: number | null = null;
    let unvaultedTags = 0;
    const collisions: string[] = [];
    for (const card of cards) {
      const head = card.querySelector<HTMLElement>(".relic-compact-head");
      const tag = card.querySelector<HTMLElement>(".relic-status-tag");
      if (!head || !tag) continue;
      const evColumn = head.children[head.children.length - 1] as HTMLElement;
      const strip = evColumn.querySelector<HTMLElement>("div");
      if (!strip) continue;
      // The tag text is translated and the vaulted modifier class is not, so
      // the class counts the wider unvaulted tag, the worst case for the price.
      if (!tag.classList.contains("vaulted")) unvaultedTags += 1;
      const tagRect = tag.getBoundingClientRect();
      const columnRect = evColumn.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      narrowestCard =
        narrowestCard === null ? card.clientWidth : Math.min(narrowestCard, card.clientWidth);
      const nameWidth = (head.children[1] as HTMLElement).getBoundingClientRect().width;
      narrowestName = narrowestName === null ? nameWidth : Math.min(narrowestName, nameWidth);
      worstSpill = Math.max(worstSpill, columnRect.left - stripRect.left);
      if (
        Math.min(tagRect.right, stripRect.right) - Math.max(tagRect.left, stripRect.left) > 0.5 &&
        Math.min(tagRect.bottom, stripRect.bottom) - Math.max(tagRect.top, stripRect.top) > 0.5
      ) {
        collisions.push((card.querySelector(".relic-row-name")?.textContent ?? "").trim());
      }
    }
    return {
      cards: cards.length,
      unvaultedTags,
      narrowestCard: narrowestCard === null ? null : Math.round(narrowestCard),
      narrowestName: narrowestName === null ? null : Math.round(narrowestName),
      worstSpill: Math.round(worstSpill),
      collisions: collisions.slice(0, 6),
      collisionCount: collisions.length,
    };
  });
}

function expectRelicHeadsIntact(
  layout: Awaited<ReturnType<typeof measureRelicCards>>,
  where: string,
): void {
  expect(layout.cards, `no relic cards rendered at ${where}`).toBeGreaterThan(5);
  expect(layout.unvaultedTags, `no unvaulted relic tag at ${where}`).toBeGreaterThan(0);
  expect(layout.narrowestCard, `no relic card measured at ${where}`).not.toBeNull();
  expect(layout.collisions, `status tag hits the price row at ${where}`).toEqual([]);
  expect(layout.collisionCount).toBe(0);
  // The numbers must stay inside their column instead of spilling onto the name.
  expect(layout.worstSpill, `price row spills left at ${where}`).toBeLessThanOrEqual(1);
}

/**
 * The narrowest card the grid can hand out is its own minmax floor. Derive it
 * from the live layout so no rem value from RelicsView is restated here.
 */
async function pinRelicGridToCardFloor(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".relic-compact-card")?.parentElement;
    if (!grid) throw new Error("relic grid missing");
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const columnCount = (width: number): number => {
      grid.style.width = `${width}px`;
      return getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
    };
    if (columnCount(4000) < 2) throw new Error("relic grid never reaches two columns");
    // A second column needs 2*floor + gap, so the width where one appears gives
    // the floor. Under the floor the track follows the container and stays at one.
    let single = 1;
    let paired = 4000;
    while (paired - single > 0.5) {
      const mid = (single + paired) / 2;
      if (columnCount(mid) >= 2) paired = mid;
      else single = mid;
    }
    const floor = (paired - gap) / 2;
    grid.style.width = `${floor}px`;
    return floor;
  });
}

async function unpinRelicGrid(page: Page): Promise<void> {
  await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".relic-compact-card")?.parentElement;
    if (grid) grid.style.width = "";
  });
}

test.describe("Shared view layout", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-ui-layout-e2e-", {
      onPage: (testPage) => {
        testPage.on("console", (message) => {
          if (message.type() === "error") {
            const location = message.location();
            consoleErrors.push(
              `${location.url}:${location.lineNumber}:${location.columnNumber} ${message.text()}`,
            );
          }
        });
      },
    });
    page = harness.page;
    consoleErrors.length = 0;
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    writeHarnessInventory(harness, testInventory());
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function headingSize(view: string): Promise<string> {
    await openView(page, view);
    const heading = page.locator("#content .view.active h2").first();
    await expect(heading).toBeVisible();
    return heading.evaluate((node) => getComputedStyle(node).fontSize);
  }

  test("Stats file import respects CSP", async () => {
    await openView(page, "stats");
    const fileInput = page.locator('input[type="file"][accept=".json"]');
    await expect(fileInput).toBeHidden();
    expect(
      consoleErrors.filter(
        (line) => /inline style/i.test(line) && /content security policy|style-src/i.test(line),
      ),
    ).toEqual([]);
  });

  test("Rivens, Wiki, and Arbitrations share the standard heading size", async () => {
    await setLayoutViewport(page, 1920, 1080);
    const standard = await headingSize("settings");
    expect(await headingSize("rivens")).toBe(standard);
    expect(await headingSize("wiki")).toBe(standard);
    expect(await headingSize("arbi")).toBe(standard);
  });

  test("Stats trade filters fit at both panel widths", async () => {
    for (const viewport of [
      { width: 1280, height: 820 },
      { width: 900, height: 600 },
    ]) {
      await setLayoutViewport(page, viewport.width, viewport.height);
      await openView(page, "stats");
      const filters = page.locator("[data-trade-filters]");
      await expect(filters).toBeVisible();
      expect(
        await filters.evaluate((node) => ({
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        })),
      ).toEqual(
        expect.objectContaining({
          clientWidth: expect.any(Number),
          scrollWidth: expect.any(Number),
        }),
      );
      expect(await filters.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
  });

  test("Inventory starts without an empty listings panel", async () => {
    await setLayoutViewport(page, 900, 600);
    await openView(page, "inventory");
    await expect(page.getByRole("heading", { name: "Market Listings" })).toHaveCount(0);
    expect(
      await page.locator("#content").evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });

  // A rotated monitor lands the inventory header in the band where the tabs no
  // longer fit beside the search box. They must not wrap mid-row and strand the
  // controls next to a strip of empty header.
  test("Inventory tabs keep one row when the search box has to drop below", async () => {
    for (const viewport of [
      { width: 1150, height: 1900 },
      { width: 1280, height: 2000 },
    ]) {
      await setLayoutViewport(page, viewport.width, viewport.height);
      await openView(page, "inventory");

      const header = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("[data-tour-tab]")) as HTMLElement[];
        const row = document.querySelector('[data-tour="inventory-tabs"]') as HTMLElement | null;
        const controls = row?.querySelector(".ml-auto") as HTMLElement | null;
        return {
          // Math.max of nothing is -Infinity, which every comparison below would
          // accept, so the empty case has to be its own assertion.
          tabCount: tabs.length,
          natural: tabs.reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0),
          available: row?.clientWidth ?? 0,
          rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
          tabsBottom: tabs.length
            ? Math.max(...tabs.map((tab) => tab.getBoundingClientRect().bottom))
            : null,
          controlsTop: controls?.getBoundingClientRect().top ?? 0,
        };
      });

      expect(header.tabCount, `no inventory tabs rendered at ${viewport.width}px`).toBeGreaterThan(
        0,
      );

      // A runner may land wider or narrower than the viewport asks for, so gate
      // on the measurement: given room for the labels, they take exactly one row
      // and the controls drop beneath them rather than wrapping the tabs.
      if (header.available >= header.natural) {
        expect(header.rows).toBe(1);
        if (header.available < header.natural + 360) {
          expect(header.controlsTop).toBeGreaterThanOrEqual(header.tabsBottom!);
        }
      }

      expect(
        await page.locator("#content").evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
  });

  // A sticky row pins to the padding box, so a narrow-width rule that pads
  // #content on all four sides drops the pinned filters a gutter below the top
  // and lets the grid scroll visibly through the strip above them.
  test("pinned filters sit flush with the scroll area on a narrow window", async () => {
    await setLayoutViewport(page, 1280, 820);
    await openView(page, "inventory");
    // Narrow enough for the compact rule, short enough that the grid scrolls.
    await setLayoutViewport(page, 760, 420);
    await page.waitForTimeout(300);
    const probe = await page.evaluate(() => {
      const content = document.querySelector("#content") as HTMLElement;
      const sticky = document.querySelector(".view-sticky-filters") as HTMLElement;
      content.scrollTop = 400;
      return {
        paddingTop: getComputedStyle(content).paddingTop,
        scrolled: content.scrollTop > 0,
        band: Math.round(sticky.getBoundingClientRect().top - content.getBoundingClientRect().top),
      };
    });

    // The gutter is the defect and the assertion: a sticky row pins to the
    // padding box, so a top padding here is what parked the pinned filters
    // below the scrollport and let the grid show through above them.
    expect(probe.paddingTop).toBe("0px");
  });

  test("new planning and inventory filters are reachable", async () => {
    await setLayoutViewport(page, 1280, 820);

    await openView(page, "inventory");
    await page.locator("[data-advanced-filters-toggle]").click();
    const customMinimum = page.getByRole("spinbutton", { name: "Custom minimum platinum" });
    await expect(customMinimum).toBeVisible();
    await customMinimum.fill("7");
    await expect(customMinimum).toHaveValue("7");

    await openView(page, "mastery");
    await page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="roadmap"]').click();
    const roadmapTabs = page.locator('[data-tour="mastery-roadmap"]');
    await expect(roadmapTabs.locator('[data-tour-tab="easy"]')).toBeVisible();
    await expect(roadmapTabs.locator('[data-tour-tab="relics"]')).toBeVisible();
    await expect(roadmapTabs.locator('[data-tour-tab="platinum"]')).toBeVisible();

    await openView(page, "relics");
    await expect(await relicOwnershipSelect(page)).toBeVisible();
    // The one toggle button among the relic filter selects.
    await expect(page.locator("[data-relic-filter-controls] .filter-tab")).toBeVisible();
  });

  test("Relic filters and card headers stay compact at desktop width", async () => {
    await setLayoutViewport(page, 1920, 1080);
    await openView(page, "relics");

    const filterRow = page.locator("[data-relic-filter-row]");
    const filterControls = page.locator("[data-relic-filter-controls]");
    await expect(filterControls).toBeVisible();

    const layout = await filterRow.evaluate((row) => {
      const tabs = row.querySelector<HTMLElement>("[data-relic-tier-tabs]");
      const controls = row.querySelector<HTMLElement>("[data-relic-filter-controls]");
      if (!tabs || !controls) throw new Error("Relic filter sections are missing");
      // Math.max of an empty child list is -Infinity, which passes any ceiling.
      if (controls.children.length === 0) throw new Error("Relic filter controls are empty");
      const tabsRect = tabs.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      return {
        rowFits: row.scrollWidth <= row.clientWidth,
        bottomDelta: Math.abs(tabsRect.bottom - controlsRect.bottom),
        maxControlHeight: Math.max(
          ...Array.from(controls.children, (child) => child.getBoundingClientRect().height),
        ),
      };
    });
    expect(layout.rowFits).toBe(true);
    expect(layout.bottomDelta).toBeLessThanOrEqual(12);
    expect(layout.maxControlHeight).toBeLessThanOrEqual(36);

    await (await relicOwnershipSelect(page)).selectOption("all");
    const firstCard = page.locator(".relic-compact-card").first();
    await expect(firstCard).toBeVisible({ timeout: 90_000 });
    const cardHeader = firstCard.locator(".relic-compact-head");
    const titleBlock = cardHeader.locator(":scope > span").nth(1);
    const metricBlock = cardHeader.locator(":scope > span").nth(2);
    const headerLayout = await Promise.all([titleBlock.boundingBox(), metricBlock.boundingBox()]);
    expect(headerLayout[0]).not.toBeNull();
    expect(headerLayout[1]).not.toBeNull();
    expect(Math.abs(headerLayout[0]!.y - headerLayout[1]!.y)).toBeLessThanOrEqual(12);
  });

  // The status tag sits in the name column and the price strip is nowrap, so a
  // head column that may shrink under its own content lands one on the other.
  // The price column has to keep its width and the name column has to keep a
  // floor of its own, or the tag and the numbers end up sharing a line.
  test("relic status tag never reaches the price row", async () => {
    const relicNames = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api?: { getRelicDatabase?: () => Promise<{ byUniqueName?: Record<string, unknown> }> };
        }
      ).api;
      const db = await api?.getRelicDatabase?.();
      return Object.keys(db?.byUniqueName ?? {});
    });
    expect(relicNames.length, "relic database is empty").toBeGreaterThan(0);
    // Seeded so owned intact relic rows exist to measure.
    writeHarnessInventory(harness, {
      Suits: [],
      LevelKeys: relicNames
        .filter((name) => name.endsWith("Bronze"))
        .slice(0, 30)
        .map((ItemType) => ({ ItemType, ItemCount: 4 })),
    });

    for (const width of [1600, 1240]) {
      await openRelics(page, width);
      const layout = await measureRelicCards(page);
      await page.screenshot({ path: test.info().outputPath(`relics-${width}.png`) });
      expectRelicHeadsIntact(layout, `${width}px`);
      // narrowestName is reported but not gated: it is an absolute pixel width and
      // the tag and price beside it are text, so a runner with different font
      // metrics squeezes the column without the layout being wrong.
      expect(layout.narrowestName, `name column not measured at ${width}px`).not.toBeNull();
    }

    // Card widths cycle back to the grid floor at every column boundary, so the
    // floor is the narrowest head a user can land on and the worst case here.
    try {
      const floor = await pinRelicGridToCardFloor(page);
      const pinned = await measureRelicCards(page);
      await page.screenshot({ path: test.info().outputPath("relics-card-floor.png") });
      expect(floor, "relic card floor not measured").toBeGreaterThan(0);
      expect(pinned.narrowestCard, "grid did not pin to its card floor").not.toBeNull();
      expect(pinned.narrowestCard!, "grid did not pin to its card floor").toBeLessThanOrEqual(
        Math.ceil(floor),
      );
      expectRelicHeadsIntact(pinned, `the ${Math.round(floor)}px card floor`);
    } finally {
      await unpinRelicGrid(page);
    }
  });

  test("resource names fit at 125% font size", async () => {
    await setLayoutViewport(page, 1920, 1200);
    await page.evaluate(() => {
      localStorage.setItem(
        "wf_theme_settings",
        JSON.stringify({ version: 1, fontSizes: { globalScale: 1.25 } }),
      );
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    writeHarnessInventory(harness, testInventory(2));

    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('[data-tour-tab="resources"]').click();
    const name = page.locator(".resource-name");
    await expect(name).toBeVisible({ timeout: 90_000 });
    await expect(name).toHaveText("ADVANCES DEBT-BOND");
    expect(
      await name.evaluate(
        (node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
      ),
    ).toBe(true);
  });
});
