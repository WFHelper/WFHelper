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

// Same reasoning as arbi.spec: EE.log replay timing is unreliable on CI.
const describePt = process.env.CI ? test.describe.skip : test.describe;

describePt("Profit-Taker run analysis", () => {
  test.setTimeout(120_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;
  let eeLogPath: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-pt-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    const userData = path.join(sandboxDir, "user-data");
    fs.mkdirSync(path.join(localAppData, "Warframe"), { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    // App.svelte reopens the setup view when neither an inventory nor helper
    // output is present, which hides the sidebar this suite navigates by.
    const helperDir = path.join(userData, "api-helper");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "inventory.json"), JSON.stringify({ Suits: [] }));

    eeLogPath = path.join(localAppData, "Warframe", "EE.log");
    fs.writeFileSync(
      eeLogPath,
      "0.127 Sys [Diag]: Current time: Tue Jul  7 15:40:49 2026 [UTC: Tue Jul  7 21:40:49 2026]\r\n",
    );

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.LOCALAPPDATA = localAppData;
    env.WFHELPER_USER_DATA = userData;

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
    page = await mainWindow(app);

    await page.evaluate(() => {
      localStorage.setItem("setup-completed-v2", "1");
      localStorage.setItem("feature-tour-done", "1");
      localStorage.setItem("app-language", "en");
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("captures a replayed run and lists it under the Profit-Taker sub-tab", async () => {
    // Sit on another view so the run has to arrive through the app-lifetime push.
    await page.locator('#sidebar [data-view="inventory"]').click();

    const fixture = fs.readFileSync(path.resolve("tests/fixtures/pt/host-single-run.log"), "utf8");
    fs.appendFileSync(eeLogPath, fixture.replace(/\n/g, "\r\n"));

    await page.locator('#sidebar [data-view="arbi"]').click();
    await page.locator('#content [data-tour-tab="profitTaker"]').click();

    await expect(page.locator("#content [data-pt-runs]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#content [data-pt-run]")).toHaveCount(1, { timeout: 60_000 });
  });

  test("the run detail shows the six stat cards and every phase", async () => {
    await page.locator("#content [data-pt-run]").first().click();

    await expect(page.locator("#content [data-pt-stat]")).toHaveCount(6);
    for (const metric of ["total", "flight", "shield", "leg", "body", "pylon"]) {
      await expect(page.locator(`#content [data-pt-stat="${metric}"]`)).toBeVisible();
    }

    // One body row plus one chip row per phase.
    await expect(page.locator("#content [data-pt-phases] tbody")).toHaveCount(4);
    await expect(page.locator("#content [data-pt-notes]")).toBeVisible();
    await expect(page.locator("#content [data-pt-prev]")).toBeDisabled();
    await expect(page.locator("#content [data-pt-next]")).toBeDisabled();
  });

  test("the sub-tab choice survives leaving and re-entering the view", async () => {
    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('#sidebar [data-view="arbi"]').click();
    await expect(page.locator("#content [data-pt-runs]")).toBeVisible({ timeout: 20_000 });
  });
});
