import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LAYOUT_KEY = "wf_layout_v1";

// Stats is the cheapest wrapped view to drive: both of its grid sections render
// with no inventory, no world state and no network.
test.describe("Per-view layout editing", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-layout-edit-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  function order(): Promise<string[]> {
    return page
      .locator('[data-layout-grid="stats"] [data-layout-section]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-layout-section") ?? ""));
  }

  async function startEditing(): Promise<void> {
    const toggle = page.locator('[data-layout-edit-toggle="stats"]');
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  }

  async function stopEditing(): Promise<void> {
    const toggle = page.locator('[data-layout-edit-toggle="stats"]');
    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
  }

  async function reload(): Promise<void> {
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
  }

  test.beforeEach(async () => {
    await page.evaluate((key) => localStorage.removeItem(key), LAYOUT_KEY);
    await reload();
    await openView(page, "stats");
    await expect(page.locator('[data-layout-grid="stats"]')).toBeVisible({ timeout: 30_000 });
  });

  test("renders the registered sections in their default order", async () => {
    expect(await order()).toEqual(["stats.summary", "stats.charts"]);
    // Nothing is stored until the user actually edits something.
    expect(await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY)).toBeNull();
  });

  test("the drag handle reorders with the keyboard", async () => {
    await startEditing();
    const handle = page.locator('[data-layout-handle="stats.summary"]');
    await handle.focus();
    await handle.press("ArrowDown");
    await expect.poll(order).toEqual(["stats.charts", "stats.summary"]);

    await handle.press("ArrowUp");
    await expect.poll(order).toEqual(["stats.summary", "stats.charts"]);
  });

  test("the move buttons reorder and Undo puts it back", async () => {
    await startEditing();
    await page.locator('[data-layout-move-down="stats.summary"]').click();
    await expect.poll(order).toEqual(["stats.charts", "stats.summary"]);

    await page.locator("[data-layout-undo]").click();
    await expect.poll(order).toEqual(["stats.summary", "stats.charts"]);
  });

  test("hiding unmounts a section and Restore brings it back", async () => {
    await startEditing();
    await page.locator('[data-layout-hide="stats.charts"]').click();
    await expect.poll(order).toEqual(["stats.summary"]);
    await expect(page.locator('[data-layout-section="stats.charts"]')).toHaveCount(0);

    const restore = page.locator('[data-layout-restore="stats.charts"]');
    await expect(restore).toBeVisible();
    await restore.click();
    await expect.poll(order).toEqual(["stats.summary", "stats.charts"]);
  });

  test("a protected section offers no hide button", async () => {
    await openView(page, "inventory");
    await page.locator('[data-layout-edit-toggle="inventory"]').click();
    await expect(page.locator('[data-layout-chrome="inventory.grid"]')).toBeVisible();
    await expect(page.locator('[data-layout-hide="inventory.grid"]')).toHaveCount(0);
    await page.locator('[data-layout-edit-toggle="inventory"]').click();
  });

  test("the span cycle widens a section and the value is persisted", async () => {
    await startEditing();
    const section = page.locator('[data-layout-section="stats.summary"]');
    await expect(section).toHaveAttribute("data-layout-span", "full");

    await page.locator('[data-layout-span-cycle="stats.summary"]').click();
    await expect(section).toHaveAttribute("data-layout-span", "1");
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY))
      .toContain("stats.summary");
  });

  test("collapsing unmounts the body and leaves a header to reopen it", async () => {
    await startEditing();
    await page.locator('[data-layout-collapse="stats.charts"]').click();
    await expect(page.locator('[data-layout-section="stats.charts"]')).toHaveAttribute(
      "data-layout-collapsed",
      "true",
    );
    await stopEditing();

    const header = page.locator('[data-layout-collapse-header="stats.charts"]');
    await expect(header).toBeVisible();
    await header.click();
    await expect(page.locator('[data-layout-section="stats.charts"]')).toHaveAttribute(
      "data-layout-collapsed",
      "false",
    );
  });

  test("a hidden section survives a renderer reload", async () => {
    await startEditing();
    await page.locator('[data-layout-hide="stats.charts"]').click();
    await expect.poll(order).toEqual(["stats.summary"]);

    await reload();
    await openView(page, "stats");
    await expect.poll(order).toEqual(["stats.summary"]);
    // Edit mode is a session state; the reload must not leave the chrome behind.
    await expect(page.locator('[data-layout-chrome="stats.summary"]')).toHaveCount(0);
  });

  test("Reset view restores the defaults for this tab only", async () => {
    await startEditing();
    await page.locator('[data-layout-hide="stats.charts"]').click();
    await page.locator('[data-layout-move-down="stats.summary"]').click();
    await expect.poll(order).toEqual(["stats.summary"]);

    await page.locator("[data-layout-reset-view]").click();
    await expect.poll(order).toEqual(["stats.summary", "stats.charts"]);
  });

  test("Reset all clears every stored view", async () => {
    await startEditing();
    await page.locator('[data-layout-hide="stats.charts"]').click();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY))
      .toContain("stats.charts");

    await page.locator("[data-layout-reset-all]").click();
    await expect.poll(order).toEqual(["stats.summary", "stats.charts"]);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY))
      .toBe(JSON.stringify({ version: 1, views: {} }));
  });

  test("a preset reorders this tab when it is scoped to it", async () => {
    await startEditing();
    await page.locator("[data-layout-presets-toggle]").click();
    await page.locator("[data-layout-preset-scope]").check();
    await page.locator('[data-layout-preset="runAnalyst"]').click();

    // Run Analyst puts the charts first on the Stats tab.
    await expect.poll(order).toEqual(["stats.charts", "stats.summary"]);
    await expect(page.locator("[data-layout-presets]")).toHaveCount(0);
  });

  // The reported bug: dragging Darvo's Deal across the column boundary died the
  // moment the move remounted the handle that was holding the pointer capture.
  test("dragging a World section into the other column moves it, and one Undo puts it back", async () => {
    // Viewport emulation, not setBounds: at the 1280 default the world grid
    // measures under LAYOUT_NARROW_MAX_PX and renders a single column.
    await page.setViewportSize({ width: 1800, height: 950 });
    await page.waitForFunction(() => window.innerWidth >= 1700);
    await openView(page, "world");

    const grid = page.locator('[data-layout-grid="world"]');
    await grid.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
    const darvo = page.locator('[data-layout-section="world.darvo"]');
    test.skip((await darvo.count()) === 0, "this world state carries no Darvo deal");
    await expect(grid).toHaveAttribute("data-layout-breakpoint", "wide");

    const toggle = page.locator('[data-layout-edit-toggle="world"]');
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await expect(page.locator('[data-layout-chrome="world.darvo"]')).toBeVisible();

    // LayoutGrid puts each column in its own div; a full-width row reads "1 / -1".
    const columns = (): Promise<{ id: string; column: string }[]> =>
      grid.locator("[data-layout-section]").evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute("data-layout-section") ?? "",
          column: (el.parentElement as HTMLElement | null)?.style.gridColumn ?? "",
        })),
      );
    const columnOf = async (id: string): Promise<string> =>
      (await columns()).find((entry) => entry.id === id)?.column ?? "";

    const before = await columnOf("world.darvo");
    expect(before === "1" || before === "2").toBe(true);
    // Aim at the far end of the other column: the split is the run's midpoint, so
    // a section next to it can be pushed across while the drag walks past it.
    const others = (await columns()).filter(
      (entry) => entry.column === (before === "1" ? "2" : "1"),
    );
    const target = before === "1" ? others[others.length - 1] : others[0];
    if (!target) throw new Error("the world grid rendered only one column of sections");

    const center = async (id: string): Promise<{ x: number; y: number }> => {
      const box = await page.locator(`[data-layout-handle="${id}"]`).boundingBox();
      if (!box) throw new Error(`the drag handle for ${id} is not on screen`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // The live world state keeps landing for a while and every arrival reflows
    // the grid, so a handle measured too early is grabbed at a stale spot.
    const handle = page.locator('[data-layout-handle="world.darvo"]');
    await expect
      .poll(
        async () => {
          const a = await center("world.darvo");
          await page.waitForTimeout(400);
          const b = await center("world.darvo");
          return a.x === b.x && a.y === b.y;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await handle.hover();
    await page.mouse.down();
    const drop = await center(target.id);
    const grab = await center("world.darvo");
    // Halfway first: the drag has to survive crossing sections it does not land
    // on, and each crossing reflows the grid under the pointer.
    await page.mouse.move((grab.x + drop.x) / 2, (grab.y + drop.y) / 2, { steps: 12 });
    // The regression itself: the first move remounts the handle, which used to
    // end the drag through lostpointercapture.
    await expect(darvo).toHaveAttribute("data-layout-dragging", "true");
    const settled = await center(target.id);
    await page.mouse.move(settled.x, settled.y, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => columnOf("world.darvo")).not.toBe(before);

    // One gesture is one undo step, however many sections it crossed.
    await page.locator("[data-layout-undo]").click();
    await expect.poll(() => columnOf("world.darvo")).toBe(before);

    if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
    await page.setViewportSize({ width: 1280, height: 820 });
  });

  test("a stored layout from a build with different ids still lists every section", async () => {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [
        LAYOUT_KEY,
        JSON.stringify({
          version: 1,
          views: {
            stats: {
              wide: {
                sections: [
                  { id: "stats.retired", span: 1, hidden: false, collapsed: false },
                  { id: "stats.charts", span: "full", hidden: false, collapsed: false },
                ],
              },
              narrow: {
                sections: [{ id: "stats.charts", span: "full", hidden: false, collapsed: false }],
              },
            },
          },
        }),
      ],
    );
    await reload();
    await openView(page, "stats");

    const ids = await order();
    expect(ids).not.toContain("stats.retired");
    expect(ids).toContain("stats.summary");
    expect(ids).toContain("stats.charts");
    // A missing first section returns to its default slot, ahead of the stored ones.
    expect(ids[0]).toBe("stats.summary");
    expect(ids[1]).toBe("stats.charts");
  });
});
