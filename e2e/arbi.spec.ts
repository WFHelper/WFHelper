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

/**
 * Boots the app against a sandboxed LOCALAPPDATA/APPDATA (own EE.log + own
 * userData), then verifies the Arbitrations schedule sub-tab and the post-run
 * summary overlay fed by a real defense-run fixture replayed into EE.log.
 */
// The EE.log-replay + overlay-window flow is unreliable on CI runners (extra
// windows, fixture timing), so it stays a local-only gate. smoke.spec covers
// app launch on CI.
const describeArbi = process.env.CI ? test.describe.skip : test.describe;

describeArbi("Arbitration schedule + post-run overlay", () => {
  test.setTimeout(120_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;
  let eeLogPath: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-arbi-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    const appData = path.join(sandboxDir, "roaming");
    fs.mkdirSync(path.join(localAppData, "Warframe"), { recursive: true });
    fs.mkdirSync(appData, { recursive: true });

    eeLogPath = path.join(localAppData, "Warframe", "EE.log");
    fs.writeFileSync(
      eeLogPath,
      "0.127 Sys [Diag]: Current time: Tue Jul  7 15:40:49 2026 [UTC: Tue Jul  7 21:40:49 2026]\r\n",
    );

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.LOCALAPPDATA = localAppData;
    env.WFHELPER_USER_DATA = path.join(appData, "wfhelper");

    app = await electron.launch({ args: ["--no-sandbox", "."], env });
    page = await app.firstWindow();

    // Fresh sandbox starts on the setup view; flag it done and reload.
    await page.evaluate(() => localStorage.setItem("setup-completed-v2", "1"));
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("world view exposes the arbitration schedule sub-tab", async () => {
    await page.locator("#sidebar").getByText("World", { exact: true }).click();
    await page.locator("#content").getByRole("button", { name: "Arbitrations", exact: true }).click();

    await expect(page.getByPlaceholder("search nodes: Alator Callisto")).toBeVisible();
    // Shows either the fetched schedule ("N entries") or the offline state.
    await expect(page.locator("text=/\\d+ entries|Schedule unavailable/").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("post-run overlay pops after a multi-rotation arbitration", async () => {
    const fixture = fs.readFileSync(
      path.resolve("tests/fixtures/arbi/stoefler-defense-ee.log"),
      "utf8",
    );

    const overlayPromise = app.waitForEvent("window", {
      predicate: (win) => win.url().includes("arbi-overlay.html"),
      timeout: 60_000,
    });
    fs.appendFileSync(eeLogPath, fixture);
    const overlay = await overlayPromise;

    await expect(overlay.locator("#run-node")).toHaveText("Stöfler (Lua)", { timeout: 15_000 });
    await expect(overlay.locator("#run-meta")).toContainText("2 rotations");
    await expect(overlay.locator("#kpi-drones")).toHaveText("3");
    await expect(overlay.locator("#kpi-kills")).toHaveText("8");
    await expect(overlay.locator("#kpi-vitus")).toContainText(/\d/);
    await expect(overlay.locator("#kpi-saturation")).toContainText("%");

    // Details must focus the main window on that run's dashboard.
    await overlay.locator("#btn-details").click();
    await expect(page.locator("text=Stöfler (Lua)").first()).toBeVisible({ timeout: 15_000 });
  });
});
