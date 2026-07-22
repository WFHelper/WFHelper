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

test.describe("Electron Smoke", () => {
  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-smoke-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.LOCALAPPDATA = localAppData;
    env.WFHELPER_USER_DATA = path.join(sandboxDir, "user-data");

    app = await electron.launch({ args: ["--no-sandbox", "."], env });
    page = await app.firstWindow();
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("renders app shell", async () => {
    // Cold CI runners occasionally exceed 40s even across retries.
    await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("#content")).toBeVisible();

    const sidebar = page.locator("#sidebar");
    if ((await sidebar.count()) > 0) {
      await expect(sidebar).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "Welcome to WFHelper" })).toBeVisible();
    }
  });
});
