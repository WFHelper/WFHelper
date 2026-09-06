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
import { evaluateInMain } from "./electronTestHarness";

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
  env.LOCALAPPDATA = localAppData;
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
    await expect(page.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  });

  test("Next advances to the inventory step and the footer ladder follows", async () => {
    const { page } = wizard;
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose Inventory Source" })).toBeVisible();
    // Body and footer are two {#if} ladders over the same step; prove both moved.
    await expect(page.getByRole("heading", { name: "App size" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  });

  test("Skip completes setup and reveals the sidebar", async () => {
    const { page } = wizard;
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 30_000 });
  });
});

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
    await expect(page.getByText("1 / 4")).toBeVisible();
  });

  test("dragging a dummy moves it", async () => {
    const dummy = wizard.page.locator("[data-placement-dummy]").first();
    const before = await dummy.boundingBox();
    expect(before).not.toBeNull();
    const area = await dummy.evaluate((el) => {
      const rect = el.parentElement!.getBoundingClientRect();
      return { x: rect.x, width: rect.width };
    });
    // Drags are clamped to the placement area, so a dummy that starts against
    // an edge cannot travel further that way and the move reads as no move.
    const dx = before!.x + before!.width / 2 < area.x + area.width / 2 ? 60 : -60;
    await wizard.page.mouse.move(before!.x + before!.width / 2, before!.y + 8);
    await wizard.page.mouse.down();
    await wizard.page.mouse.move(before!.x + before!.width / 2 + dx, before!.y + 48, { steps: 8 });
    await wizard.page.mouse.up();
    const after = await dummy.boundingBox();
    expect(Math.sign(after!.x - before!.x)).toBe(Math.sign(dx));
  });

  test("the sub-wizard walks its four overlays and finishes", async () => {
    const { page } = wizard;
    for (const step of ["2 / 4", "3 / 4", "4 / 4"]) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByText(step)).toBeVisible();
    }
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 30_000 });
  });
});
