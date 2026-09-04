import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { mainWindow } from "./mainWindow";

// Extra windows and fixture timing make EE.log replay unreliable on CI, so this
// remains a local gate. smoke.spec covers app launch on CI.
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

    // A pre-squad-parsing record plus its stored log: init must backfill players.
    const userData = path.join(appData, "wfhelper");
    const logsDir = path.join(userData, "arbi-logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const oldRunLog = [
      "100.000 Script [Info]: ThemedSquadOverlay.lua: Mission name: Arbitration: Casta Defense (Ceres)",
      "105.000 Game [Info]: HostPlayer loadout loader finished.",
      "112.000 Game [Info]: ClientOne loadout loader finished.",
      "150.000 Sys [Info]: OnAgentCreated /Npc/CorpusEliteShieldDroneAgent7",
      "400.000 Sys [Info]: Created /Lotus/Interface/DefenseReward.swf",
      "700.000 Sys [Info]: Created /Lotus/Interface/DefenseReward.swf",
    ].join("\r\n");
    const gz = zlib.gzipSync(oldRunLog);
    fs.writeFileSync(path.join(logsDir, "2026-07-08_00-15-00.log.gz"), gz);
    const startedAt = new Date("2026-07-08T00:15:00").getTime();
    fs.writeFileSync(
      path.join(userData, "arbi-runs.json"),
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            id: "2026-07-08_00-15-00",
            startedAt,
            endedAt: startedAt + 600_000,
            missionName: "Arbitration: Casta Defense (Ceres)",
            node: "Casta Defense (Ceres)",
            missionType: "defense",
            durationSec: 600,
            rotations: 2,
            drones: 1,
            totalEnemies: 40,
            vitusActual: null,
            logFile: "2026-07-08_00-15-00.log.gz",
            logSizeBytes: gz.length,
            endReason: "mission-end",
            source: "live",
            stats: null,
          },
        ],
      }),
    );

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.LOCALAPPDATA = localAppData;
    env.WFHELPER_USER_DATA = userData;

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
    page = await mainWindow(app);

    // Fresh sandbox starts on the setup view; flag it done and reload.
    await page.evaluate(() => {
      localStorage.setItem("setup-completed-v2", "1");
      localStorage.setItem("app-language", "en");
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("world view exposes the arbitration schedule sub-tab", async () => {
    await page.locator('#sidebar [data-view="world"]').click();
    await page.locator('#content [data-tour-tab="arbis"]').click();

    await expect(page.locator('[data-tour="arbi-schedule"] [data-search-focus]')).toBeVisible();
    // Shows either the fetched schedule ("Entries: N") or the offline state.
    await expect(page.locator("text=/Entries: \\d+|Schedule unavailable/").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("backfills squad names onto a pre-update run and shows them", async () => {
    await page.locator('#sidebar [data-view="arbi"]').click();
    await page.locator("#content").getByText("Casta Defense (Ceres)").first().click();
    await expect(page.locator("#content").getByText("HostPlayer, ClientOne").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("post-run overlay pops after a multi-rotation arbitration", async () => {
    // Leave the Arbitrations view first, so the run has to arrive through the
    // app-lifetime push rather than a view-mounted listener.
    await page.locator('#sidebar [data-view="inventory"]').click();
    await expect(page.locator("#content [data-arbi-runs]")).toHaveCount(0);

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
    await expect(overlay.locator("#run-meta")).toContainText("Rotations: 2");
    await expect(overlay.locator("#kpi-drones")).toHaveText("3");
    await expect(overlay.locator("#kpi-kills")).toHaveText("8");
    await expect(overlay.locator("#kpi-vitus")).toContainText(/\d/);
    await expect(overlay.locator("#kpi-saturation")).toContainText("%");

    // Details must focus the main window on that run's dashboard.
    await overlay.locator("#btn-details").click();
    await expect(page.locator("text=Stöfler (Lua)").first()).toBeVisible({ timeout: 15_000 });
  });

  test("detail view carries the cadence timeline, notes and run navigation", async () => {
    // The overlay's Details button left the freshly captured run open.
    await expect(page.locator("#content [data-arbi-timeline]")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#content [data-arbi-confidence]")).toBeVisible();

    const notes = page.locator("#content [data-arbi-notes]");
    await notes.fill("e2e note");
    await notes.blur();

    // Newest run is first in the list, so only "next" can move.
    await expect(page.locator("#content [data-arbi-prev]")).toBeDisabled();
    await page.locator("#content [data-arbi-next]").click();
    await expect(page.locator("#content").getByText("Casta Defense (Ceres)").first()).toBeVisible();
    await expect(page.locator("#content [data-arbi-notes]")).toHaveValue("");

    // Back to the captured run: the note has to have survived the navigation.
    await page.locator("#content [data-arbi-prev]").click();
    await expect(page.locator("#content [data-arbi-notes]")).toHaveValue("e2e note");
  });

  test("compares two selected runs against the filtered average", async () => {
    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('#sidebar [data-view="arbi"]').click();
    await expect(page.locator("#content [data-arbi-runs]")).toBeVisible();

    const rowChecks = page.locator("#content table tbody input[type=checkbox]");
    await rowChecks.nth(0).check();
    await rowChecks.nth(1).check();
    await page.locator("#content [data-arbi-compare]").click();

    const table = page.locator("#content [data-arbi-compare-panel]");
    await expect(table).toBeVisible();
    // Metric label, two run columns, then the average column.
    await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(4);
  });
});
