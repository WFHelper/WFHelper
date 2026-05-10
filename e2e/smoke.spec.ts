import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

test.describe("Electron Smoke", () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";

    app = await electron.launch({ args: ["."], env });
    page = await app.firstWindow();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("renders app shell", async () => {
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#sidebar")).toBeVisible();
    await expect(page.locator("#content")).toBeVisible();
  });
});

