import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELTRA = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";

// Each test is self-contained: a failed test restarts the worker, which re-runs
// beforeAll with a fresh sandbox and empty localStorage.
test.describe("Horizontal tab persistence", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-tab-persist-e2e-");
    page = harness.page;
    writeHarnessInventory(harness, {
      Suits: [],
      LongGuns: [{ ItemType: ACCELTRA, XP: 450_000 }],
      XPInfo: [{ ItemType: ACCELTRA, XP: 450_000 }],
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Tab labels are translated, so rows are located by data-tour-tab.
  function tab(key: string) {
    return page.locator("#content .view.active").locator(`[data-tour-tab="${key}"]`);
  }

  test("Inventory keeps its filter tab across view switches", async () => {
    await openView(page, "inventory");
    await tab("full_sets").click();
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");

    await openView(page, "settings");
    await openView(page, "inventory");
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");
  });

  test("Foundry keeps its category tab across view switches", async () => {
    await openView(page, "foundry");
    await tab("cat:Primary").click();
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");

    await openView(page, "inventory");
    await openView(page, "foundry");
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");
  });

  test("Mastery keeps its category and status tabs across view switches", async () => {
    await openView(page, "mastery");
    await expect(tab("Primary")).toBeVisible({ timeout: 30_000 });
    await tab("Primary").click();
    await tab("mastered").click();

    await openView(page, "settings");
    await openView(page, "mastery");
    await expect(tab("Primary")).toHaveAttribute("data-active", "true");
    await expect(tab("mastered")).toHaveAttribute("data-active", "true");
  });

  test("Mastery keeps its Roadmap sub-tab across view switches", async () => {
    await openView(page, "mastery");
    await tab("roadmap").click();
    await tab("relics").click();
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect(tab("relics")).toHaveAttribute("data-active", "true");

    await openView(page, "settings");
    await openView(page, "mastery");
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect(tab("relics")).toHaveAttribute("data-active", "true");
  });

  test("Rivens keeps its view tab across view switches", async () => {
    await openView(page, "rivens");
    await tab("veiled").click();
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");

    await openView(page, "settings");
    await openView(page, "rivens");
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");
  });

  test("World keeps its view tab across view switches", async () => {
    await openView(page, "world");
    await tab("arbis").click();
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");

    await openView(page, "inventory");
    await openView(page, "world");
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");
  });

  test("Relics keeps its tier tab across view switches", async () => {
    await openView(page, "relics");
    await tab("Axi").click();
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");

    await openView(page, "inventory");
    await openView(page, "relics");
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");
  });

  test("Market keeps its order tab across view switches", async () => {
    await openView(page, "market");
    await tab("browse").click();
    await expect(tab("browse")).toHaveAttribute("data-active", "true");

    await openView(page, "inventory");
    await openView(page, "market");
    await expect(tab("browse")).toHaveAttribute("data-active", "true");
  });

  test("Settings intentionally returns to General", async () => {
    await openView(page, "settings");
    await tab("appearance").click();
    await expect(tab("appearance")).toHaveClass(/active/);

    await openView(page, "inventory");
    await openView(page, "settings");
    await expect(tab("general")).toHaveClass(/active/);
  });

  test("Every non-Settings tab survives a renderer reload", async () => {
    await openView(page, "inventory");
    await tab("full_sets").click();
    await openView(page, "foundry");
    await tab("cat:Primary").click();
    await openView(page, "mastery");
    await tab("roadmap").click();
    await tab("relics").click();
    await openView(page, "world");
    await tab("arbis").click();
    await openView(page, "relics");
    await tab("Axi").click();
    await openView(page, "market");
    await tab("browse").click();
    await openView(page, "rivens");
    await tab("veiled").click();

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });

    await openView(page, "inventory");
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");
    await openView(page, "foundry");
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");
    await openView(page, "mastery");
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_mastery_roadmap_tab")))
      .toBe("relics");
    await openView(page, "world");
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");
    await openView(page, "relics");
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");
    await openView(page, "market");
    await expect(tab("browse")).toHaveAttribute("data-active", "true");
    await openView(page, "rivens");
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");
    await openView(page, "settings");
    await expect(tab("general")).toHaveClass(/active/);
  });
});

// The sidebar rows and the rail width are user-owned state stored under
// wf_sidebar_order / wf_sidebar_width; both must survive a renderer reload.
test.describe("Sidebar order and width persistence", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-sidebar-layout-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  function readOrder(): Promise<string[]> {
    return page
      .locator("#sidebar [data-view]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-view") ?? ""));
  }

  function readWidth(): Promise<number> {
    return page.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
      ),
    );
  }

  async function reload(): Promise<void> {
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
  }

  test.beforeEach(async () => {
    await page.evaluate(() => {
      localStorage.removeItem("wf_sidebar_order");
      localStorage.removeItem("wf_sidebar_width");
    });
    await reload();
  });

  test("Reordering in Settings moves the sidebar row and survives a reload", async () => {
    await openView(page, "settings");
    const before = await readOrder();
    const from = before.indexOf("foundry");
    expect(from).toBeGreaterThanOrEqual(0);

    const handle = page.locator('[data-tab-order-handle="foundry"]');
    await handle.focus();
    await handle.press("ArrowDown");

    const expected = [...before];
    expected.splice(from, 1);
    expected.splice(from + 1, 0, "foundry");
    await expect.poll(readOrder).toEqual(expected);

    await reload();
    expect(await readOrder()).toEqual(expected);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_sidebar_order")))
      .toContain("foundry");
  });

  test("Reset restores the default sidebar order", async () => {
    await openView(page, "settings");
    const original = await readOrder();

    const handle = page.locator('[data-tab-order-handle="market"]');
    await handle.focus();
    await handle.press("ArrowUp");
    await expect.poll(readOrder).not.toEqual(original);

    await page.locator("[data-tab-order-reset]").click();
    await expect.poll(readOrder).toEqual(original);
  });

  test("Hiding a tab from the reorder list still removes it from the sidebar", async () => {
    await openView(page, "settings");
    await page.locator('[data-tab-order-row="relics"] input[type="checkbox"]').uncheck();
    await expect.poll(readOrder).not.toContain("relics");

    await page.locator('[data-tab-order-row="relics"] input[type="checkbox"]').check();
    await expect.poll(readOrder).toContain("relics");
  });

  test("Inventory and Settings cannot be hidden", async () => {
    await openView(page, "settings");
    await expect(
      page.locator('[data-tab-order-row="inventory"] input[type="checkbox"]'),
    ).toBeDisabled();
    await expect(
      page.locator('[data-tab-order-row="settings"] input[type="checkbox"]'),
    ).toBeDisabled();
  });

  test("Dragging the grip resizes the sidebar and the width survives a reload", async () => {
    expect(await readWidth()).toBe(300);

    const grip = page.locator("[data-sidebar-grip]");
    const box = await grip.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 80, y, { steps: 8 });
    await page.mouse.up();

    const dragged = await readWidth();
    expect(dragged).toBeGreaterThan(190);
    expect(dragged).toBeLessThan(260);

    await reload();
    expect(await readWidth()).toBe(dragged);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_sidebar_width")))
      .toBe(String(dragged));
  });

  test("Double-clicking the grip resets the width to the default", async () => {
    const grip = page.locator("[data-sidebar-grip]");
    const box = await grip.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(readWidth).toBeLessThan(280);

    await grip.dblclick();
    await expect.poll(readWidth).toBe(300);
  });

  test("Collapse shuts to the rail and reopens at the previous width", async () => {
    const grip = page.locator("[data-sidebar-grip]");
    const box = await grip.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 6 });
    await page.mouse.up();
    const widened = await readWidth();
    expect(widened).toBeGreaterThan(320);

    await page.locator("[data-sidebar-collapse]").click();
    await expect.poll(readWidth).toBe(60);

    await page.locator("[data-sidebar-collapse]").click();
    await expect.poll(readWidth).toBe(widened);
  });

  test("A stored order from another build still lists every tab", async () => {
    await page.evaluate(() => {
      localStorage.setItem(
        "wf_sidebar_order",
        JSON.stringify(["settings", "workshop2", "market", "inventory"]),
      );
    });
    await reload();

    const order = await readOrder();
    expect(order).not.toContain("workshop2");
    expect(order.slice(0, 2)).toEqual(["settings", "market"]);
    // Every registered view is still reachable, in some order.
    for (const view of ["inventory", "foundry", "mastery", "stats", "world", "relics", "wiki"]) {
      expect(order).toContain(view);
    }
  });
});
