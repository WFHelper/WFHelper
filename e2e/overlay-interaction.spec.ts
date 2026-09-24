import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

async function enterOverlay(
  harness: ElectronTestHarness,
  kind: "planner" | "reward" | "riven" = "planner",
): Promise<void> {
  await evaluateInMain(
    harness.app,
    ({ app }, kind) => {
      const main = process.mainModule!;
      if (kind === "riven") {
        const riven = main.require(
          `${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`,
        ) as typeof import("../ipc/rivenOverlayIpc");
        riven.onRivenSessionOpen();
        riven.setRivenInteractiveMode(true);
        return;
      }
      const controllers = main.require(
        `${app.getAppPath()}/.electron-build/ipc/rewardOverlayIpc`,
      ) as typeof import("../ipc/rewardOverlayIpc");
      const controller =
        kind === "planner"
          ? controllers.plannerWindowsController
          : controllers.rewardWindowsController;
      controller.createOverlayWindow({ show: true });
      controller.setOverlayInteractiveMode(true, { focus: true });
      controller.sendOverlayEvent("overlay-interaction-mode", { interactive: true });
    },
    kind,
  );
}

async function interactive(harness: ElectronTestHarness): Promise<boolean> {
  return evaluateInMain(harness.app, ({ app }) => {
    const { default: ctx } = process.mainModule!.require(
      `${app.getAppPath()}/.electron-build/ipc/context`,
    ) as typeof import("../ipc/context");
    return ctx.overlayInteractiveMode;
  });
}

// Playwright's keyboard bypasses Electron's before-input-event.
async function pressOverlayKey(
  harness: ElectronTestHarness,
  target: "plannerOverlayWindow" | "overlayWindow" | "rivenOverlayLeftWindow" | "mainWindow",
  keyCode: string,
  modifiers: ("control" | "shift")[] = [],
): Promise<void> {
  const focused = await evaluateInMain(
    harness.app,
    async ({ app }, { target, keyCode, modifiers }) => {
      const { default: ctx } = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/ipc/context`,
      ) as typeof import("../ipc/context");
      const win = ctx[target]!;
      win.focus();
      const focused = win.isFocused();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return focused;
    },
    { target, keyCode, modifiers },
  );
  expect(focused).toBe(true);
}

test("F7 exits focused overlays after a planner resize", async () => {
  const testInfo = test.info();
  test.skip(process.platform !== "win32", "Windows foreground hook fallback");
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-focused-interaction-");
    await enterOverlay(harness);
    const planner = await overlayWindow(harness, "mode=planner");
    await expect(planner.locator("#btn-close")).toBeVisible();
    await evaluateInMain(harness.app, ({ app }) => {
      const { default: ctx } = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/ipc/context`,
      ) as typeof import("../ipc/context");
      const win = ctx.plannerOverlayWindow!;
      win.setBounds({ ...win.getBounds(), width: win.getBounds().width + 40 });
      win.focus();
    });
    await planner.screenshot({ path: testInfo.outputPath("planner-interactive.png") });
    await pressOverlayKey(harness, "plannerOverlayWindow", "F7");
    const appHarness = harness;
    await expect.poll(() => interactive(appHarness)).toBe(false);
    await expect(planner.locator("#btn-close")).toBeHidden();
    expect(
      await evaluateInMain(harness.app, ({ app }) => {
        const { default: ctx } = process.mainModule!.require(
          `${app.getAppPath()}/.electron-build/ipc/context`,
        ) as typeof import("../ipc/context");
        return ctx.plannerOverlayWindow!.isFocusable();
      }),
    ).toBe(false);
    await planner.screenshot({ path: testInfo.outputPath("planner-passive.png") });
    for (const kind of ["reward", "riven"] as const) {
      await enterOverlay(harness, kind);
      const overlay =
        kind === "reward"
          ? await overlayWindow(harness, "overlay.html", "mode=planner")
          : await overlayWindow(harness, "side=left");
      await expect(overlay.locator("#btn-close")).toBeVisible();
      await pressOverlayKey(
        harness,
        kind === "reward" ? "overlayWindow" : "rivenOverlayLeftWindow",
        "F7",
      );
      await expect(overlay.locator("#btn-close")).toBeHidden();
      await expect.poll(() => interactive(appHarness)).toBe(false);
    }
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("focused interaction shortcut honors its binding and enabled setting", async () => {
  test.skip(process.platform !== "win32", "Windows foreground hook fallback");
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-interaction-binding-");
    await enterOverlay(harness);
    const planner = await overlayWindow(harness, "mode=planner");
    await expect(planner.locator("#btn-close")).toBeVisible();
    await pressOverlayKey(harness, "mainWindow", "F7");
    expect(await interactive(harness)).toBe(true);
    await evaluateInMain(harness.app, ({ app }) => {
      const { default: ctx } = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/ipc/context`,
      ) as typeof import("../ipc/context");
      ctx.overlaySettings.interactionHotkey = "Control+Shift+R";
      ctx.plannerOverlayWindow!.focus();
    });
    await pressOverlayKey(harness, "plannerOverlayWindow", "F7");
    expect(await interactive(harness)).toBe(true);
    for (const key of ["Tab", "R"]) {
      await pressOverlayKey(harness, "plannerOverlayWindow", key, ["control"]);
      expect(await interactive(harness)).toBe(true);
    }
    await evaluateInMain(harness.app, ({ app }) => {
      const { default: ctx } = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/ipc/context`,
      ) as typeof import("../ipc/context");
      ctx.overlaySettings.interactionHotkeyEnabled = false;
    });
    await pressOverlayKey(harness, "plannerOverlayWindow", "R", ["control", "shift"]);
    expect(await interactive(harness)).toBe(true);
    await evaluateInMain(harness.app, ({ app }) => {
      const { default: ctx } = process.mainModule!.require(
        `${app.getAppPath()}/.electron-build/ipc/context`,
      ) as typeof import("../ipc/context");
      ctx.overlaySettings.interactionHotkeyEnabled = true;
    });
    await pressOverlayKey(harness, "plannerOverlayWindow", "R", ["control", "shift"]);
    const appHarness = harness;
    await expect.poll(() => interactive(appHarness)).toBe(false);
    await expect(planner.locator("#btn-close")).toBeHidden();
  } finally {
    await closeElectronTestHarness(harness);
  }
});
