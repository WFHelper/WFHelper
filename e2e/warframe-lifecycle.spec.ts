import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

interface LifecycleTestState {
  gameRunning: boolean;
  samples: number;
  watcherSpawns: number;
  loginRegistrations: number;
}

test("Warframe lifecycle stays opt-in and closes only after an observed game exits", async () => {
  test.skip(process.platform !== "win32");
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  let closed = false;
  const pageErrors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-warframe-lifecycle-", {
      onPage: (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
      },
    });
    const { app, page, sandboxDir } = harness;
    app.on("close", () => {
      closed = true;
    });
    const nativeSession = await evaluateInMain(app, ({ app }) => {
      const moduleApi = process.getBuiltinModule("module") as {
        createRequire: (filename: string) => (id: string) => unknown;
      };
      const load = moduleApi.createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const processApi = load("./services/win32Process.js") as {
        enumProcessNames: () => { pid: number; name: string }[] | null;
        getProcessSessionId: (pid: number) => number | null;
        queryExePath: (pid: number) => { status: "ok"; path: string };
      };
      const actualSession = processApi.getProcessSessionId(process.pid);
      const snapshotContainsApp = processApi
        .enumProcessNames()
        ?.some((entry) => entry.pid === process.pid);
      const scope = globalThis as unknown as { lifecycleTest: LifecycleTestState };
      scope.lifecycleTest = {
        gameRunning: false,
        samples: 0,
        watcherSpawns: 0,
        loginRegistrations: 0,
      };
      const fakeGamePid = 2_147_483_647;
      processApi.enumProcessNames = () => {
        scope.lifecycleTest.samples += 1;
        return [
          { pid: process.pid, name: "WFHelper.exe" },
          ...(scope.lifecycleTest.gameRunning
            ? [{ pid: fakeGamePid, name: "Warframe.x64.exe" }]
            : []),
        ];
      };
      processApi.getProcessSessionId = () => 1;
      processApi.queryExePath = (pid) => ({
        status: "ok",
        path: pid === fakeGamePid ? "C:\\Fixture\\Warframe.x64.exe" : process.execPath,
      });
      app.setLoginItemSettings = () => {
        scope.lifecycleTest.loginRegistrations += 1;
      };
      const childProcess = load("node:child_process") as typeof import("node:child_process");
      const { EventEmitter } = load("node:events") as typeof import("node:events");
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = ((command: string, args: unknown, options: unknown) => {
        if (
          /[\\/]conhost\.exe$/i.test(command) &&
          Array.isArray(args) &&
          args.some(
            (arg: unknown) => typeof arg === "string" && /[\\/]warframe-watcher\.ps1$/i.test(arg),
          )
        ) {
          scope.lifecycleTest.watcherSpawns += 1;
          const child = Object.assign(new EventEmitter(), { unref: () => undefined });
          queueMicrotask(() => child.emit("spawn"));
          return child;
        }
        return Reflect.apply(originalSpawn, childProcess, [command, args, options]);
      }) as typeof childProcess.spawn;
      return { actualSession, snapshotContainsApp };
    });
    expect(nativeSession.actualSession).not.toBeNull();
    expect(nativeSession.actualSession).toBeGreaterThanOrEqual(0);
    expect(nativeSession.snapshotContainsApp).toBe(true);

    const state = () =>
      evaluateInMain(app, () => ({
        ...(globalThis as unknown as { lifecycleTest: LifecycleTestState }).lifecycleTest,
      }));
    const setGame = async (running: boolean) => {
      const before = (await state()).samples;
      await evaluateInMain(
        app,
        (_electron, value) => {
          (
            globalThis as unknown as { lifecycleTest: LifecycleTestState }
          ).lifecycleTest.gameRunning = value;
        },
        running,
      );
      await expect.poll(async () => (await state()).samples).toBeGreaterThan(before);
    };
    const configFile = path.join(sandboxDir, "user-data", "warframe-watcher.json");
    const enabledOnDisk = (): unknown => {
      if (!fs.existsSync(configFile)) return null;
      return (JSON.parse(fs.readFileSync(configFile, "utf8")) as { enabled?: unknown }).enabled;
    };

    await setLayoutViewport(page, 1440, 1000);
    await openView(page, "settings");
    const toggle = page.locator('[data-setting="warframe-lifecycle"] input[type="checkbox"]');
    await expect(toggle).not.toBeChecked();
    expect(enabledOnDisk()).not.toBe(true);
    const initialProcessState = await evaluateInMain(app, ({ app }) => {
      const status = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/services/warframeStatus`,
      ) as typeof import("../services/warframeStatus");
      const state = (globalThis as unknown as { lifecycleTest: LifecycleTestState }).lifecycleTest;
      state.gameRunning = true;
      status.getWarframeProcessState(true);
      state.gameRunning = false;
      // A startup sample from the real game can outlive the process mock.
      const cached = status.getWarframeProcessState();
      return { cached, fresh: status.getWarframeProcessState(true) };
    });
    expect(initialProcessState).toEqual({ cached: true, fresh: false });
    await toggle.check();
    await expect.poll(enabledOnDisk).toBe(true);
    await expect.poll(async () => (await state()).watcherSpawns).toBe(1);
    expect((await state()).loginRegistrations).toBe(0);
    await page.reload();
    await openView(page, "settings");
    await expect(toggle).toBeChecked();
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("warframe-lifecycle-enabled.png"),
    });

    // Manual starts without an observed game must outlive the automatic-exit grace.
    await page.waitForTimeout(12_500);
    expect(closed).toBe(false);
    await setGame(true);
    await page.waitForTimeout(2_500);
    await setGame(false);
    await page.waitForTimeout(3_000);
    expect(closed).toBe(false);
    await setGame(true);
    await page.waitForTimeout(2_500);
    expect(closed).toBe(false);

    await toggle.uncheck();
    await expect.poll(enabledOnDisk).toBeNull();
    expect(fs.existsSync(path.join(sandboxDir, "user-data", "warframe-watcher.ps1"))).toBe(false);
    await evaluateInMain(app, () => {
      (globalThis as unknown as { lifecycleTest: LifecycleTestState }).lifecycleTest.gameRunning =
        false;
    });
    await page.waitForTimeout(12_500);
    expect(closed).toBe(false);
    await toggle.check();
    await expect.poll(enabledOnDisk).toBe(true);
    await expect.poll(async () => (await state()).watcherSpawns).toBe(2);
    await setGame(true);
    await page.waitForTimeout(2_500);
    const exit = app.waitForEvent("close", { timeout: 20_000 });
    await setGame(false);
    await exit;
    expect(closed).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    if (harness && closed) {
      fs.rmSync(harness.sandboxDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    } else {
      await closeElectronTestHarness(harness);
    }
  }
});
