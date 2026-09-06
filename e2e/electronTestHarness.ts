import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { mainWindow } from "./mainWindow";

interface ElectronTestHarnessOptions {
  storage?: Record<string, string>;
  inventory?: unknown;
  onPage?: (page: Page) => void | Promise<void>;
  /** Electron --lang switch, which is what navigator.language reports. */
  lang?: string;
  /** Leave app-language unset so detectLocale() falls through to the OS locale. */
  skipLanguageSeed?: boolean;
  /** JSON files to drop into userData before launch, keyed by file name. */
  userDataFiles?: Record<string, unknown>;
}

export interface ElectronTestHarness {
  app: ElectronApplication;
  page: Page;
  sandboxDir: string;
  helperDir: string;
}

export async function launchElectronTestHarness(
  prefix: string,
  options: ElectronTestHarnessOptions = {},
): Promise<ElectronTestHarness> {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localAppData = path.join(sandboxDir, "local");
  const userData = path.join(sandboxDir, "user-data");
  const helperDir = path.join(userData, "api-helper");
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(
    path.join(helperDir, "inventory.json"),
    JSON.stringify(options.inventory ?? { Suits: [] }),
  );
  for (const [name, contents] of Object.entries(options.userDataFiles ?? {})) {
    fs.writeFileSync(path.join(userData, name), JSON.stringify(contents));
  }

  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
  env.LOCALAPPDATA = localAppData;
  env.WFHELPER_USER_DATA = userData;

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["--no-sandbox", `--lang=${options.lang ?? "en-US"}`, "."],
      env,
    });
    const page = await mainWindow(app);
    await options.onPage?.(page);
    await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(
      (storage) => {
        for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
      },
      {
        "setup-completed-v2": "1",
        "feature-tour-done": "1",
        ...(options.skipLanguageSeed ? {} : { "app-language": "en" }),
        ...options.storage,
      },
    );
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });

    return { app, page, sandboxDir, helperDir };
  } catch (error) {
    // Without this the caller never gets a harness, so the process and the
    // sandbox dir would both leak on any failure above.
    try {
      await app?.close();
    } catch {
      // already gone
    }
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Sets the viewport in CSS pixels, which is what layout assertions mean.
 *
 * setViewportSize sets the *device* viewport, and the app then divides it by a
 * zoom derived from the display's shortest edge (config/runtime/uiScale.ts):
 * 1.15 on a 1440p panel, 0.9 on a small CI display. A raw 1800 therefore lands
 * at 1565 CSS px on a developer monitor and 2000 on CI, so width-sensitive
 * specs pass in one place and fail in the other. Measuring the zoom and
 * scaling through it makes 1800 mean 1800 everywhere.
 */
export async function setLayoutViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  const applied = await page.evaluate(() => window.innerWidth);
  if (!applied) return;
  const zoom = width / applied;
  if (Math.abs(zoom - 1) < 0.01) return;
  await page.setViewportSize({
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
  });
}

/** Sidebar labels are translated, so navigate by data-view. */
export async function openView(page: Page, view: string): Promise<void> {
  await page.locator(`#sidebar [data-view="${view}"]`).click();
  await page.waitForTimeout(300);
}

export async function setDisplayLanguage(page: Page, code: string): Promise<void> {
  await page.locator('#sidebar [data-view="settings"]').click();
  await page.locator('[data-setting="language"] select').selectOption(code);
}

export async function overlayWindow(
  harness: ElectronTestHarness,
  match: string,
  reject?: string,
): Promise<Page> {
  const attempts = 60;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const win of harness.app.windows()) {
      const url = win.url();
      if (url.includes(match) && (!reject || !url.includes(reject))) return win;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`overlay window ${match} never appeared`);
}

/**
 * Playwright loses the main-process context while Electron is still opening
 * windows, surfacing as "Execution context was destroyed". Retry only that.
 */
export async function evaluateInMain<R, A>(
  app: ElectronApplication,
  fn: (electron: typeof import("electron"), arg: A) => R | Promise<R>,
  arg?: A,
): Promise<R> {
  let lastError: unknown;
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return (await app.evaluate(fn as never, arg as never)) as R;
    } catch (err) {
      if (!/Execution context was destroyed/i.test(String(err))) throw err;
      lastError = err;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

export function writeHarnessInventory(harness: ElectronTestHarness, inventory: unknown): void {
  fs.writeFileSync(path.join(harness.helperDir, "inventory.json"), JSON.stringify(inventory));
}

export async function closeElectronTestHarness(
  harness: ElectronTestHarness | undefined,
): Promise<void> {
  if (!harness) return;
  try {
    // close() waits for a clean exit and can hang a CI teardown for the whole
    // 120s hook budget; a stuck Electron gets 15s, then a hard kill.
    const closed = harness.app.close().then(
      () => true,
      () => false,
    );
    if (!(await Promise.race([closed, delay(15_000)]))) {
      forceKillElectronTree(harness.app.process().pid);
      await Promise.race([closed, delay(5_000)]);
    }
  } finally {
    removeSandbox(harness.sandboxDir);
  }
}

// Node's kill only hits the main process; a surviving GPU or network service
// child keeps cache files locked and fails the sandbox delete with EBUSY.
function forceKillElectronTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

function removeSandbox(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    // A leaked temp sandbox beats failing the run over cleanup.
    console.warn(`[harness] sandbox cleanup left ${dir}: ${String(error)}`);
  }
}

function delay(ms: number): Promise<false> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(false), ms).unref();
  });
}
