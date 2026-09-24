import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { mainWindow } from "./mainWindow";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
} from "./electronTestHarness";

// The shared harness seeds setup-completed-v2, so no other spec ever sees the
// wizard. It is three components now, which is exactly why it needs covering.
interface Wizard {
  app: ElectronApplication;
  page: Page;
  sandboxDir: string;
}

async function launchWizard(inventory: unknown | null): Promise<Wizard> {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-setup-"));
  const localAppData = path.join(sandboxDir, "local");
  const userData = path.join(sandboxDir, "user-data");
  const helperDir = path.join(userData, "api-helper");
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  const inventoryPath = path.join(helperDir, "inventory.json");
  if (inventory) fs.writeFileSync(inventoryPath, JSON.stringify(inventory));

  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
  env.WFHELPER_DISABLE_DBWIN = "1";
  env.LOCALAPPDATA = localAppData;
  env.APPDATA = path.join(sandboxDir, "roaming");
  env.WFHELPER_USER_DATA = userData;

  const app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
  const page = await mainWindow(app);
  await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => localStorage.setItem("app-language", "en"));
  await page.reload();
  await expect(page.locator("#content.setup-active")).toBeVisible({ timeout: 90_000 });
  if (inventory) {
    // The manual source is the only import path that needs no pinned binary.
    await evaluateInMain(
      app,
      ({ dialog }, filePaths) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths });
      },
      [inventoryPath],
    );
  }
  return { app, page, sandboxDir };
}

async function closeWizard(wizard: Wizard | undefined): Promise<void> {
  if (!wizard) return;
  await wizard.app.close();
  fs.rmSync(wizard.sandboxDir, { recursive: true, force: true });
}

test.describe.serial("First-run setup wizard", () => {
  let wizard: Wizard;

  test.beforeAll(async () => {
    wizard = await launchWizard(null);
  });
  test.afterAll(() => closeWizard(wizard));

  test("opens on the appearance step with the sidebar hidden", async () => {
    await expect(wizard.page.locator("#sidebar")).toHaveCount(0);
    await expect(wizard.page.getByRole("heading", { name: "Welcome to WFHelper" })).toBeVisible();
  });

  test("the appearance step renders its controls and its pinned footer", async () => {
    const { page } = wizard;
    await expect(page.getByRole("heading", { name: "App size" })).toBeVisible();
    await expect(page.getByRole("slider", { name: "App size" })).toBeVisible();
    await expect(page.locator("button[aria-pressed]").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
    await expect(page.locator("[data-setup-without-inventory]")).toBeVisible();
    await page.locator("[data-setup-language] button").nth(1).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("app-language"))).toBe("de");
    await page.locator("[data-setup-language] button").first().click();
    await page.screenshot({
      path: test.info().outputPath("welcome-language.png"),
      animations: "disabled",
    });
  });

  test("Next advances to the inventory step and the footer ladder follows", async () => {
    const { page } = wizard;
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose Inventory Source" })).toBeVisible();
    // Body and footer are two {#if} ladders over the same step; prove both moved.
    await expect(page.getByRole("heading", { name: "App size" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-setup-without-inventory]")).toBeVisible();
  });

  test("no inventory completes setup, opens World and survives a reload", async () => {
    const { page } = wizard;
    await page.locator('[data-setup-source="none"]').click();
    await page.locator("[data-setup-use-source]").click();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-tour-card]")).toHaveCount(0);
    expect(await page.evaluate(() => window.api.getInventoryStatus())).toMatchObject({
      source: "none",
      found: false,
    });
    await expect(page.locator('#sidebar [data-view="world"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.reload();
    await expect(page.locator('#sidebar [data-view="world"]')).toHaveAttribute(
      "aria-current",
      "page",
      { timeout: 30_000 },
    );
    await expect(page.locator("#content.setup-active")).toHaveCount(0);
    await page.locator('#sidebar [data-view="settings"]').click();
    await expect(page.locator('[data-setting="inventory-source"] button').last()).toHaveClass(
      /bg-accent/,
    );
    const hint = page.locator("[data-no-inventory-hint]");
    await expect(hint).toBeVisible();
    expect(await hint.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(300);
    for (const dismiss of await page.locator("article.pointer-events-auto button").all()) {
      await dismiss.click();
    }
    await page.screenshot({
      path: test.info().outputPath("no-inventory-settings.png"),
      animations: "disabled",
    });
  });
});

test("Settings can disconnect inventory while retaining its file and market access", async () => {
  const harness = await launchElectronTestHarness("wf-no-inventory-settings-", {
    inventory: { Suits: [], RegularCredits: 4200 },
  });
  try {
    const { page } = harness;
    const inventoryPath = path.join(harness.helperDir, "inventory.json");
    const original = fs.readFileSync(inventoryPath, "utf8");
    await expect
      .poll(() => page.evaluate(() => window.api.getInventoryStatus()))
      .toMatchObject({ found: true });
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-setting="inventory-source"] button').last().click();
    await expect
      .poll(() => page.evaluate(() => window.api.getInventoryStatus()))
      .toMatchObject({ source: "none", found: false });
    expect(await page.evaluate(() => window.api.getInventory())).toBeNull();
    expect(fs.readFileSync(inventoryPath, "utf8")).toBe(original);
    await page.locator('#sidebar [data-view="market"]').click();
    await expect(page.locator('#sidebar [data-view="market"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("#content.setup-active")).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#sidebar [data-view="world"]')).toHaveAttribute(
      "aria-current",
      "page",
      { timeout: 30_000 },
    );
    expect(await page.evaluate(() => window.api.getInventory())).toBeNull();
  } finally {
    await closeElectronTestHarness(harness);
  }
});

// Drags are clamped to the placement area, so a dummy that starts against an
// edge cannot travel further that way and the move reads as no move.
async function dragDummy(page: Page, key: string): Promise<number> {
  const dummy = page.locator(`[data-placement-dummy="${key}"]`);
  const before = await dummy.boundingBox();
  expect(before).not.toBeNull();
  const area = await dummy.evaluate((el) => {
    const rect = el.parentElement!.getBoundingClientRect();
    return { x: rect.x, width: rect.width };
  });
  const dx = before!.x + before!.width / 2 < area.x + area.width / 2 ? 60 : -60;
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 8);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + dx, before!.y + 48, { steps: 8 });
  await page.mouse.up();
  const after = await dummy.boundingBox();
  expect(Math.sign(after!.x - before!.x)).toBe(Math.sign(dx));
  return dx;
}

test.describe.serial("Setup overlay placement step", () => {
  let wizard: Wizard;

  test.beforeAll(async () => {
    // Loading inventory calls finish(), which jumps straight to the placement step.
    wizard = await launchWizard({ Suits: [] });
    const { page } = wizard;
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Import inventory JSON" }).click();
    await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  });
  test.afterAll(() => closeWizard(wizard));

  test("shows a draggable dummy for every overlay and a size slider", async () => {
    const { page } = wizard;
    await expect(page.locator("[data-placement-dummy]").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("slider")).toBeVisible();
    await expect(page.getByText("1 / 5")).toBeVisible();
  });

  test("dragging a dummy moves it", async () => {
    await dragDummy(wizard.page, "reward");
  });

  test("the sub-wizard walks its five overlays, ending on the trade toast", async () => {
    const { page } = wizard;
    for (const step of ["2 / 5", "3 / 5", "4 / 5", "5 / 5"]) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByText(step)).toBeVisible();
    }
    await expect(page.locator('[data-placement-step="tradeNotification"]')).toBeVisible();
    // The toast has a fixed size, so its step offers no size slider.
    await expect(page.getByRole("slider")).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.api.getOverlaySettings())).overlayWindowBounds
        .tradeNotification,
    ).toBeUndefined();
    await dragDummy(page, "tradeNotification");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.api.getOverlaySettings())).overlayWindowBounds
            .tradeNotification,
      )
      .toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 30_000 });
  });
});
