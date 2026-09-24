import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { mainWindow } from "./mainWindow";

test.describe("WFM status pill (fixture mode)", () => {
  test.setTimeout(240_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-status-pill-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });
    const fixturePath = path.join(sandboxDir, "wfm-orders.json");
    fs.writeFileSync(fixturePath, JSON.stringify({ sell: [], buy: [] }));
    const helperDir = path.join(sandboxDir, "user-data", "api-helper");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "inventory.json"), JSON.stringify({ Suits: [] }));

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.WFHELPER_DISABLE_DBWIN = "1";
    env.LOCALAPPDATA = localAppData;
    env.APPDATA = path.join(sandboxDir, "roaming");
    env.WFHELPER_USER_DATA = path.join(sandboxDir, "user-data");
    env.WFHELPER_WFM_FIXTURES = fixturePath;

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
    page = await mainWindow(app);

    await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => {
      localStorage.setItem("setup-completed-v2", "1");
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await page.locator('#sidebar [data-view="inventory"]').click();
    await expect(page.locator("#content")).toHaveAttribute("data-view", "inventory");
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("the titlebar shows the market status without opening the Market tab", async () => {
    const testInfo = test.info();
    const pill = page.locator("header [data-wfm-status-pill]");
    await expect(pill).toBeVisible({ timeout: 30_000 });
    // Startup seeds presence, so the pill is filled in on a tab that never
    // fetched it. The fixture serves "online".
    await expect(pill.locator("[data-wfm-status-current]")).toHaveAttribute(
      "data-wfm-status-current",
      "online",
    );
    await expect(page.locator("#content")).toHaveAttribute("data-view", "inventory");

    const shot = testInfo.outputPath("wfm-status-pill-titlebar.png");
    await page.screenshot({ path: shot });
    await testInfo.attach("titlebar", { path: shot, contentType: "image/png" });
  });

  test("the titlebar panel carries the whole presence row", async () => {
    const pill = page.locator("header [data-wfm-status-pill]");
    const current = pill.locator("[data-wfm-status-current]");

    await current.click();
    const panel = pill.locator("[data-wfm-status-menu]");
    await expect(panel).toBeVisible();
    // Everything the Market header offers, not just the three statuses.
    await expect(panel.locator("[data-wfm-status-option]")).toHaveCount(3);
    await expect(panel.locator(".presence-chip")).toHaveCount(8);
    await expect(panel.locator(".presence-minutes")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("wfm-status-pill-menu.png") });

    await panel.locator('[data-wfm-status-option="invisible"]').click();
    await expect(current).toHaveAttribute("data-wfm-status-current", "invisible");
    // A settings panel stays open while the pill behind it updates.
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(pill.locator("[data-wfm-status-menu]")).toHaveCount(0);
    await expect(page.locator("#content")).toHaveAttribute("data-view", "inventory");
  });

  test("the Market header still carries the same row", async () => {
    await page.locator('#sidebar [data-view="market"]').click();
    await expect(page.locator("#content")).toHaveAttribute("data-view", "market");

    const bar = page.locator("#content [data-wfm-presence-bar]");
    await expect(bar).toHaveCount(1, { timeout: 30_000 });
    await expect(bar.locator("[data-wfm-status-option]")).toHaveCount(3);
    await expect(bar.locator(".presence-chip")).toHaveCount(8);
    const shot = test.info().outputPath("wfm-presence-market-header.png");
    await page.screenshot({ path: shot });
    await test.info().attach("market header", { path: shot, contentType: "image/png" });
  });
});
