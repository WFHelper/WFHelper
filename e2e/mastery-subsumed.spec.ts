import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const GRID = "#content .view.active [data-mastery-grid]";

async function gridCount(page: Page): Promise<number> {
  return Number(await page.locator(GRID).getAttribute("data-item-count"));
}

// The grid mounts only the rows near the viewport, so reading every card means
// scrolling the list through.
async function allGridNames(page: Page): Promise<string[]> {
  return page.evaluate(async (grid) => {
    const scroller = document.getElementById("content");
    if (!scroller) return [];
    const frames = (): Promise<void> =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      );
    const seen = new Set<string>();
    scroller.scrollTop = 0;
    await frames();
    for (;;) {
      document.querySelectorAll(`${grid} .item-name`).forEach((name) => {
        seen.add(name.textContent?.trim() ?? "");
      });
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
      scroller.scrollTop += Math.max(100, scroller.clientHeight / 2);
      await frames();
    }
    scroller.scrollTop = 0;
    return [...seen];
  }, GRID);
}

test.describe("Mastery subsumed filter", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-mastery-subsumed-e2e-", {
      inventory: {
        Suits: [{ ItemType: "/Lotus/Powersuits/Rhino/Rhino", ItemId: { $oid: "a1" }, XP: 1000000 }],
        InfestedFoundry: { ConsumedSuits: [{ s: "/Lotus/Powersuits/Ninja/Ninja" }] },
      },
    });
    page = harness.page;
    await page.locator('#sidebar [data-view="mastery"]').click();
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("tri-state drops everything that can never be subsumed", async () => {
    const select = page.locator("#content .view.active select[data-subsumed]");
    await expect(select).toBeVisible({ timeout: 60_000 });
    const names = page.locator(`${GRID} .item-name`);
    await expect(names.first()).toBeVisible();
    const allCount = await gridCount(page);
    expect(allCount).toBeGreaterThan(100);
    // Windowed: far fewer cards mount than the list holds.
    expect(await names.count()).toBeLessThan(allCount);

    await select.selectOption("yes");
    await expect(names).toHaveText(["Ash"]);

    // Only base warframes survive "no": primes and non-frames have no flag.
    await select.selectOption("no");
    await expect.poll(() => gridCount(page)).toBeGreaterThan(30);
    const noCount = await gridCount(page);
    expect(noCount).toBeLessThan(allCount / 2);
    const noNames = await allGridNames(page);
    expect(noNames).toHaveLength(noCount);
    expect(noNames.filter((name) => /Prime/.test(name))).toEqual([]);
    expect(noNames).not.toContain("Ash");
  });

  test("summary strip stays compact at full width", async () => {
    // At the 1280 default the full-size strip fills the row, so w-fit and
    // w-full look identical; widen until fit-content leaves a visible gap.
    // Viewport emulation, not setBounds: a runner display can be narrower than
    // 1800px and Windows clamps the window to it.
    await setLayoutViewport(page, 1800, 900);
    await page.waitForFunction(() => window.innerWidth >= 1700);
    await page.locator("#content .view.active select[data-subsumed]").selectOption("all");
    const row = page.locator("#content .view.active [data-mastery-summary]");
    await expect(row).toBeVisible();
    const ring = row.locator('svg[viewBox="0 0 120 120"]');
    await expect(ring).toBeVisible();

    // The ring drives the row height, so an oversized ring shows up as a taller row.
    await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeLessThan(130);
    await expect.poll(async () => (await row.boundingBox())?.width ?? 0).toBeGreaterThan(600);

    // Panel starts right of the ring and stops short of the grid edge: fit-content.
    const ringBox = await ring.boundingBox();
    const panelBox = await row.locator(":scope > div").nth(1).boundingBox();
    expect(panelBox?.x ?? 0).toBeGreaterThanOrEqual((ringBox?.x ?? 0) + (ringBox?.width ?? 0));
    await expect
      .poll(async () => {
        const panel = await row.locator(":scope > div").nth(1).boundingBox();
        const grid = await page.locator("#content .view.active .item-grid").boundingBox();
        if (!panel || !grid) return 0;
        return grid.x + grid.width - (panel.x + panel.width);
      })
      .toBeGreaterThanOrEqual(40);
  });
});
