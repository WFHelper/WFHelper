import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { mainWindow } from "./mainWindow";
import { evaluateInMain } from "./electronTestHarness";

test.describe("Electron Smoke", () => {
  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;
  let launchEnv: Record<string, string>;

  function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("second Electron process did not exit"));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  }

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-smoke-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });

    launchEnv = { ...process.env } as Record<string, string>;
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    launchEnv.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    launchEnv.WFHELPER_DISABLE_DBWIN = "1";
    launchEnv.LOCALAPPDATA = localAppData;
    launchEnv.APPDATA = path.join(sandboxDir, "roaming");
    launchEnv.WFHELPER_USER_DATA = path.join(sandboxDir, "user-data");

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env: launchEnv });
    page = await mainWindow(app);
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

  test("uses grayscale text with software rendering", async () => {
    const rendering = await evaluateInMain(app, ({ app: electronApp }) => ({
      hardwareAcceleration: electronApp.isHardwareAccelerationEnabled(),
      lcdTextDisabled: electronApp.commandLine.hasSwitch("disable-lcd-text"),
    }));

    expect(rendering).toEqual({ hardwareAcceleration: false, lcdTextDisabled: true });
  });

  test("keeps one process and restores its window", async () => {
    await evaluateInMain(app, ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes("renderer/dist/index.html"))
        ?.minimize();
    });

    const executableName = fs.readFileSync(
      path.join(process.cwd(), "node_modules", "electron", "path.txt"),
      "utf8",
    );
    const executable = path.join(process.cwd(), "node_modules", "electron", "dist", executableName);
    const second = spawn(executable, ["--no-sandbox", "."], {
      cwd: process.cwd(),
      env: launchEnv,
      stdio: "ignore",
    });

    await expect(waitForExit(second, 15_000)).resolves.toBe(0);
    await expect
      .poll(() =>
        evaluateInMain(app, ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes("renderer/dist/index.html"),
          );
          return window
            ? { minimized: window.isMinimized(), visible: window.isVisible() }
            : { minimized: true, visible: false };
        }),
      )
      .toEqual({ minimized: false, visible: true });
  });
});
