import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

test.describe("Electron Smoke", () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";

    app = await electron.launch({ args: ["--no-sandbox", "."], env });
    page = await app.firstWindow();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("renders app shell", async () => {
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#content")).toBeVisible();

    const sidebar = page.locator("#sidebar");
    if ((await sidebar.count()) > 0) {
      await expect(sidebar).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "Welcome to WFHelper" })).toBeVisible();
    }
  });
});

