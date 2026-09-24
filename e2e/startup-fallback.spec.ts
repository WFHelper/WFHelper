import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

import { collectElectronArtifacts } from "./electronArtifacts";
import { evaluateInMain, stopElectron } from "./electronTestHarness";
import {
  startStartupScenario,
  type StartupMode,
  type StartupObservation,
} from "./scenarios/startup-bootstrap";

test.describe("Native main window startup fallbacks", () => {
  let app: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let sandbox: string;
  let saveArtifacts: Awaited<ReturnType<typeof collectElectronArtifacts>> | undefined;

  test.afterEach(async () => {
    try {
      await saveArtifacts?.().catch((error: unknown) =>
        console.warn("[startup] artifacts:", error),
      );
      if (app && child?.exitCode === null) await stopElectron(app);
    } finally {
      await saveArtifacts?.().catch((error: unknown) =>
        console.warn("[startup] artifacts:", error),
      );
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  async function launch(mode: StartupMode): Promise<void> {
    app = undefined;
    child = undefined;
    saveArtifacts = undefined;
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-startup-"));
    const userData = path.join(sandbox, "user-data");
    fs.mkdirSync(userData);
    fs.writeFileSync(
      path.join(userData, "inventory-reload-state.json"),
      JSON.stringify({ inventorySource: "none" }),
    );
    fs.mkdirSync(path.join(sandbox, "local"));
    fs.mkdirSync(path.join(sandbox, "roaming"));
    const entry = path.join(sandbox, "startup.cjs");
    fs.writeFileSync(
      entry,
      `(${startStartupScenario.toString()})(${JSON.stringify(process.cwd())}, ${JSON.stringify(mode)});`,
    );
    const env = {
      ...process.env,
      WFHELPER_USER_DATA: userData,
      WFHELPER_EE_LOG: path.join(sandbox, "EE.log"),
      LOCALAPPDATA: path.join(sandbox, "local"),
      APPDATA: path.join(sandbox, "roaming"),
      WFHELPER_DISABLE_KEYBOARD_HOOK: "1",
      WFHELPER_DISABLE_DBWIN: "1",
      WF_DISABLE_AUTO_UPDATE: "1",
    } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", entry], env });
    } catch (error) {
      saveArtifacts = await collectElectronArtifacts(null, sandbox);
      await saveArtifacts(true, error);
      throw error;
    }
    child = app.process();
    saveArtifacts = await collectElectronArtifacts(app, sandbox);
    await expect.poll(async () => (await observation()).windowId).toBeGreaterThan(0);
  }

  function observation(): Promise<StartupObservation> {
    return evaluateInMain(
      app!,
      () =>
        (globalThis as typeof globalThis & { startupObservation: StartupObservation })
          .startupObservation,
    );
  }

  async function nativeState() {
    return evaluateInMain(app!, ({ BrowserWindow }) => {
      const state = (globalThis as typeof globalThis & { startupObservation: StartupObservation })
        .startupObservation;
      const window = BrowserWindow.fromId(state.windowId)!;
      return {
        visible: window.isVisible(),
        maximized: window.isMaximized(),
        bounds: window.getNormalBounds(),
      };
    });
  }

  for (const [mode, reason] of [
    ["grace", "did-finish-load"],
    ["deadline", "deadline"],
    ["load-error", "load-error"],
  ] as const) {
    test(`${reason} reveals the native window when first-paint readiness is unavailable`, async () => {
      await launch(mode);
      await expect.poll(async () => (await nativeState()).visible, { timeout: 25_000 }).toBe(true);
      const state = await observation();
      expect(state.initial?.visible).toBe(false);
      expect(state.initial?.maximized).toBe(false);
      expect(state.initial?.background).toMatch(/060a12$/i);
      const { maximized, ...savedBounds } = state.savedBounds;
      expect(state.initial?.bounds).toEqual(savedBounds);
      expect((await nativeState()).bounds).toEqual(savedBounds);
      if (maximized) await expect.poll(async () => (await nativeState()).maximized).toBe(true);
      expect(state.calls).toEqual(maximized ? ["maximize", "show"] : ["show"]);
      const log = fs.readFileSync(path.join(sandbox, "user-data", "logs", "main.log"), "utf8");
      expect(log).toContain(`window shown via ${reason} fallback`);
      if (mode === "load-error") {
        expect(state.failedLoads).toBe(1);
        expect(log).toContain("Startup fixture rejected renderer loadFile");
      } else {
        expect(state.suppressedReady).toBeGreaterThan(0);
        if (mode === "deadline") expect(state.suppressedLoad).toBeGreaterThan(0);
      }
      await evaluateInMain(app!, () => {
        (
          globalThis as typeof globalThis & { releaseStartupReady: () => void }
        ).releaseStartupReady();
      });
      expect((await observation()).calls).toEqual(state.calls);
    });
  }

  test("closing before the fallback deadline exits without showing a replacement window", async () => {
    await launch("close-before-show");
    await expect
      .poll(async () => (await observation()).suppressedLoad, { timeout: 12_000 })
      .toBeGreaterThan(0);
    expect((await nativeState()).visible).toBe(false);
    expect((await observation()).calls).toEqual([]);
    const process = app!.process();
    const exited = new Promise<number | null>((resolve) => process.once("exit", resolve));
    await evaluateInMain(app!, ({ BrowserWindow }) => {
      const state = (globalThis as typeof globalThis & { startupObservation: StartupObservation })
        .startupObservation;
      BrowserWindow.fromId(state.windowId)!.close();
    });
    await expect.poll(() => process.exitCode, { timeout: 10_000 }).toBe(0);
    expect(await exited).toBe(0);
    const log = fs.readFileSync(path.join(sandbox, "user-data", "logs", "main.log"), "utf8");
    expect(log).not.toContain("window shown via");
  });
});
