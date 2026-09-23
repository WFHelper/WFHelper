import fs from "node:fs";
import path from "node:path";

import { test, expect, type Frame, type Locator, type Page } from "@playwright/test";

import type { ArbiRunRecord } from "../config/shared/arbiTypes";
import {
  getOverlayDescriptor,
  OVERLAY_LAYOUT_KINDS,
  normalizeOverlayLayout,
  type OverlayEditState,
  type OverlayLayout,
  type OverlayLayoutKind,
} from "../config/shared/overlayLayout";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

const CASES = [
  { kind: "planner", field: "relicName" },
  { kind: "rivenLeft", field: "weaponName" },
  { kind: "rivenRight", field: "weaponName" },
  { kind: "arbiSummary", field: "vitusValue" },
  { kind: "tradeNotification", field: "platinumValue" },
] as const;

test("planner reward details stay inside crowded recommendation cards", async () => {
  let harness: ElectronTestHarness | undefined;
  try {
    const fields = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) =>
        ["Icon", "Name", "Chance", "Owned"].map((part) => [
          `reward${index}${part}`,
          { x: 0, y: 0, scale: 1, color: null, hidden: false },
        ]),
      ).flat(),
    );
    harness = await launchElectronTestHarness("wfh-planner-crowded-", {
      userDataFiles: {
        "overlay-settings.json": {
          notificationSoundEnabled: false,
          overlayLayouts: { planner: { version: 1, fields: {} } },
        },
      },
    });
    await callMain(harness, "rewardOverlayIpc", "warmPlannerOverlayWindow");
    const planner = await overlayWindow(harness, "mode=planner");
    await expect.poll(async () => (await readState(planner)).kind).toBe("planner");
    const state = await readState(planner);
    expect(state.layout).toEqual(normalizeOverlayLayout("planner", undefined));
    const rows = Array.from({ length: 40 }, (_, index) => ({
      relicName: `Lith A${index + 1}`,
      count: index + 1,
      quality: "radiant",
      vaulted: true,
      platEv: 20 - index / 4,
      ducatEv: 50,
      rewards: Array.from({ length: 6 }, (_, reward) => ({
        name: `Prime Component ${reward + 1}`,
        chance: reward === 5 ? 10 : 18,
        rarity: reward === 5 ? "rare" : "common",
        ownedCount: reward,
      })),
    }));
    for (const [name, layout] of [
      ["compact", state.layout],
      ["expanded", normalizeOverlayLayout("planner", { version: 1, fields })],
    ] as const) {
      for (const scale of [1, 0.8]) {
        await evaluateInMain(
          harness.app,
          ({ app, BrowserWindow }, payload) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
              candidate.webContents.getURL().includes("mode=planner"),
            );
            if (!window) throw new Error("Planner window did not mount");
            window.setSize(510, 705);
            window.webContents.setZoomFactor(payload.scale);
            const load = process
              .getBuiltinModule("module")
              .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
            (
              load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc")
            ).plannerWindowsController.showOverlayWindowInactive();
            window.webContents.send("relic-planner-trigger");
            window.webContents.send("relic-recommendations", { era: "Lith", rows: payload.rows });
            window.webContents.send("overlay-edit-state", payload.state);
          },
          { scale, rows, state: { ...state, layout } },
        );
        await expect(planner.locator(".plan-card")).toHaveCount(rows.length);
        const reward = planner.locator('[data-reward-field="reward5Name"]').first();
        if (name === "compact") await expect(reward).toBeHidden();
        else await expect(reward).toBeVisible();
        await nativeScreenshot(harness, planner, `planner-${name}-${scale}.png`);
        if (name === "compact") {
          expect((await planner.locator(".plan-card").first().boundingBox())?.height).toBeLessThan(
            65,
          );
          continue;
        }
        const overflow = await planner.locator(".plan-card").evaluateAll((cards) =>
          cards.map((card) => {
            const last = card.querySelector(".plan-reward:last-child");
            if (!last) throw new Error("Planner card has no rewards");
            return last.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom;
          }),
        );
        expect(Math.max(...overflow)).toBeLessThanOrEqual(0);
      }
    }
  } finally {
    await closeElectronTestHarness(harness);
  }
});

async function nativeScreenshot(
  harness: ElectronTestHarness,
  surface: Page,
  filename: string,
): Promise<void> {
  const png = await evaluateInMain(
    harness.app,
    async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === url,
      );
      if (!window) throw new Error("Overlay window did not mount");
      return (await window.webContents.capturePage()).toPNG().toString("base64");
    },
    surface.url(),
  );
  fs.writeFileSync(test.info().outputPath(filename), Buffer.from(png, "base64"));
}

function readState(surface: Page | Frame): Promise<OverlayEditState> {
  return surface.evaluate(() =>
    (
      window as unknown as {
        overlayLayoutApi: { getLayout: () => Promise<OverlayEditState> };
      }
    ).overlayLayoutApi.getLayout(),
  );
}

async function input(control: Locator, value: string): Promise<void> {
  await control.evaluate((element, next) => {
    (element as HTMLInputElement).value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await expect(control).toHaveValue(value);
}

async function windowIds(
  harness: ElectronTestHarness,
): Promise<Array<{ id: number; url: string }>> {
  return evaluateInMain(harness.app, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((window) => ({ id: window.id, url: window.webContents.getURL() }))
      .sort((a, b) => a.id - b.id),
  );
}

// Settings lists one button per overlay; the setup wizard offers one per panel of the
// placement step on screen, so the caller walks the wizard to that step first.
async function openEditor(page: Page, kind: OverlayLayoutKind): Promise<Frame> {
  await page.locator(`[data-overlay-editor-open="${kind}"]`).click();
  await expect(page.locator(`[data-overlay-editor="${kind}"]`)).toBeVisible();
  const element = await page.locator("[data-reward-editor-frame]").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error(`${kind} preview did not mount`);
  await expect(frame.locator("body")).toHaveClass(/reward-layout-editing/);
  await expect.poll(async () => (await readState(frame)).kind).toBe(kind);
  return frame;
}

async function callMain(
  harness: ElectronTestHarness,
  moduleName: string,
  method: string,
  ...args: unknown[]
): Promise<void> {
  await evaluateInMain(
    harness.app,
    ({ app }, payload) => {
      const moduleApi = process.getBuiltinModule("module") as {
        createRequire: (file: string) => (id: string) => Record<string, unknown>;
      };
      const load = moduleApi.createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const target = load(`./ipc/${payload.moduleName}.js`)[payload.method];
      if (typeof target !== "function") throw new Error("Missing overlay fixture entry point");
      target(...payload.args);
    },
    { moduleName, method, args },
  );
}

function summaryRun(vitusActual: number | null): ArbiRunRecord {
  return {
    id: "overlay-customization-fixture",
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_001_800_000,
    missionName: "Arbitration: Casta Defense (Ceres)",
    node: "Casta (Ceres)",
    missionType: "defense",
    missionTypeRaw: "MT_DEFENSE",
    durationSec: 1800,
    rotations: 6,
    drones: 12,
    totalEnemies: 600,
    vitusActual,
    logFile: null,
    logSizeBytes: 0,
    endReason: "mission-end",
    source: "live",
    players: ["FixtureTenno"],
    stats: {
      killsPerDrone: 50,
      avgDroneIntervalSec: 150,
      expectedVitusMean: 14.2,
      expectedVitusStd: 3.1,
      vitusPerMin: 0.47,
      wavesPerRotation: 5,
      droneTimestamps: [],
      rewardTimestamps: [],
      preciseStartSec: 0,
      lastActivitySec: 1800,
      saturationBuckets: [{ minCount: 15, label: "15+", seconds: 765, pct: 42.5 }],
      waves: null,
    },
  };
}

async function assertNativeLayout(
  surface: Page,
  kind: OverlayLayoutKind,
  layout: OverlayLayout,
): Promise<void> {
  await surface.waitForLoadState("domcontentloaded");
  await expect.poll(async () => (await readState(surface)).layout).toEqual(layout);
  expect((await readState(surface)).sessionId).toBeNull();
  expect((await readState(surface)).kind).toBe(kind);
  await expect(surface.locator("body")).not.toHaveClass(/reward-layout-editing/);
  expect(
    await surface.evaluate(() =>
      Object.keys((window as unknown as { overlayLayoutApi: object }).overlayLayoutApi).sort(),
    ),
  ).toEqual(["defaultFieldStyle", "getLayout", "onLayout"]);
}

test("all overlay previews edit individual fields and preserve separate saved layouts", async () => {
  test.setTimeout(360_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  const layouts: Partial<Record<OverlayLayoutKind, OverlayLayout>> = {};
  try {
    harness = await launchElectronTestHarness("wfh-all-overlay-editors-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page } = harness;
    harness.app.on("window", (window) => {
      window.on("pageerror", (error) => errors.push(error.message));
    });
    await evaluateInMain(harness.app, ({ app, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true);
      app.on("browser-window-created", (_event, window) => window.webContents.setAudioMuted(true));
    });
    await callMain(harness, "rewardOverlayIpc", "warmPlannerOverlayWindow");
    const warmPlanner = await overlayWindow(harness, "mode=planner");
    await expect.poll(async () => (await readState(warmPlanner)).kind).toBe("planner");
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="overlays"]').click();
    await expect(page.locator("[data-overlay-editor-open]")).toHaveCount(
      OVERLAY_LAYOUT_KINDS.length,
    );
    await page.locator('[data-overlay-editor-open="tradeNotification"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("customization-tab.png") });
    const settingsPath = path.join(harness.sandboxDir, "user-data", "overlay-settings.json");

    for (const { kind, field } of CASES) {
      const beforeWindows = await windowIds(harness);
      let frame = await openEditor(page, kind);
      await expect(page.locator("[data-reward-editor-elements] summary")).toBeInViewport();
      const descriptor = getOverlayDescriptor(kind);
      const leaf = frame.locator(`[data-reward-field="${field}"]`).first();
      await expect(leaf).toBeVisible();
      expect(await windowIds(harness)).toEqual(beforeWindows);
      expect(await leaf.locator("[data-reward-field]").count()).toBe(0);
      await page
        .locator(`[data-overlay-editor="${kind}"]`)
        .screenshot({ path: test.info().outputPath(`${kind}-default.png`) });

      if (kind === "planner") {
        await expect(frame.locator('[data-reward-field="reward0Owned"]').first()).toHaveText(/0/);
        await expect(frame.locator('[data-reward-field="reward5Owned"]').first()).toHaveText(/\?/);
      }
      if (kind === "arbiSummary") {
        await expect(frame.locator('[data-reward-field="actualVitusValue"]')).toHaveText("51");
      }
      if (kind === "tradeNotification") {
        await expect(page.locator("[data-reward-editor-window-scale]")).toHaveCount(0);
        await expect(frame.locator('[data-reward-field="quantity"]')).toHaveText(/\d/);
        await expect(frame.locator('[data-reward-field="platinumValue"]')).toHaveText(/\d/);
        await expect(frame.locator('[data-reward-field="platinumUnit"]')).toHaveText("p");
      } else {
        await expect(page.locator("[data-reward-editor-window-scale]")).toBeVisible();
      }

      await leaf.scrollIntoViewIfNeeded();
      const box = await leaf.boundingBox();
      const canvas = await page.locator("[data-reward-editor-frame]").boundingBox();
      if (!box || !canvas) throw new Error(`${kind} editable field has no bounds`);
      const zoom = canvas.width / descriptor.canvas.width;
      const move = kind === "tradeNotification" ? -14 : 14;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + move * zoom,
        box.y + box.height / 2 + 3 * zoom,
        { steps: 4 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => Math.abs((await readState(frame)).layout.fields[field]?.x ?? 0))
        .toBeGreaterThan(3);
      await input(page.locator("[data-reward-editor-scale]"), "1.35");
      await expect
        .poll(async () => (await readState(frame)).layout.fields[field]?.scale)
        .toBe(1.35);
      await expect(leaf).toHaveCSS("scale", "1.35");
      await input(page.locator("[data-reward-editor-color]"), "#33aaff");
      await expect(leaf).toHaveCSS("color", "rgb(51, 170, 255)");
      await page.locator("[data-reward-editor-hidden]").check();
      await expect(leaf).toBeHidden();
      await page.locator("[data-reward-editor-elements] summary").click();
      await page.locator(`[data-reward-editor-field="${field}"]`).click();
      await page.locator("[data-reward-editor-hidden]").uncheck();
      await expect(leaf).toBeVisible();
      await page.locator("[data-reward-editor-elements] summary").click();

      for (const variant of descriptor.variants) {
        await page.locator("[data-reward-editor-preview]").selectOption(variant.value);
        await expect.poll(async () => (await readState(frame)).previewVariant).toBe(variant.value);
        await expect(page.locator('[data-reward-editor] [role="alert"]')).toHaveCount(0);
        if (kind === "arbiSummary" && variant.value === "unknown") {
          await expect(frame.locator('[data-reward-field="actualVitusValue"]')).toHaveText("?");
        }
      }
      await page.locator("[data-reward-editor-preview]").selectOption(descriptor.variants[0].value);
      await expect(leaf).toBeVisible();
      await expect(leaf).toHaveCSS("color", "rgb(51, 170, 255)");
      await page
        .locator(`[data-overlay-editor="${kind}"]`)
        .screenshot({ path: test.info().outputPath(`${kind}-customized.png`) });
      layouts[kind] = structuredClone((await readState(frame)).layout);
      await page.locator("[data-reward-editor-save]").click();
      await expect(page.locator("[data-overlay-editor]")).toHaveCount(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayLayouts[kind]).toEqual(
        layouts[kind],
      );

      frame = await openEditor(page, kind);
      expect((await readState(frame)).layout).toEqual(layouts[kind]);
      await page.locator("[data-reward-editor-reset]").click();
      await expect
        .poll(async () => (await readState(frame)).layout)
        .toEqual(normalizeOverlayLayout(kind, undefined));
      await page.locator("[data-reward-editor-cancel]").click();
      await expect(page.locator("[data-overlay-editor]")).toHaveCount(0);
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayLayouts[kind]).toEqual(
        layouts[kind],
      );
      expect(await windowIds(harness)).toEqual(beforeWindows);
    }

    await page.locator('[data-tour-tab="notifications"]').click();
    const duration = page.locator('[data-setting="windows-notification-seconds"] input');
    await duration.fill("19");
    await duration.press("Tab");
    await expect
      .poll(() => JSON.parse(fs.readFileSync(settingsPath, "utf8")).windowsNotificationSeconds)
      .toBe(19);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).overlayLayouts).toEqual(layouts);

    await page.evaluate(() => localStorage.removeItem("setup-completed-v2"));
    await page.reload();
    await expect(page.locator('#content[data-view="setup"]')).toBeVisible();
    await page.locator(".setup-content + div button.btn-primary").click();
    await evaluateInMain(
      harness.app,
      ({ BrowserWindow }, url) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === url)
          ?.webContents.send("inventory-updated", { Suits: [] });
      },
      page.url(),
    );
    await expect(page.locator('[data-overlay-editor-open="reward"]')).toBeVisible();
    for (const kind of ["planner", "rivenRight"] as const) {
      await page.locator("[data-setup-overlay-next]").click();
      const frame = await openEditor(page, kind);
      expect((await readState(frame)).layout).toEqual(layouts[kind]);
      await page.locator("[data-reward-editor-cancel]").click();
      await expect(page.locator("[data-overlay-editor]")).toHaveCount(0);
    }

    await evaluateInMain(harness.app, ({ app }) => {
      const moduleApi = process.getBuiltinModule("module") as {
        createRequire: (file: string) => (id: string) => Record<string, unknown>;
      };
      const load = moduleApi.createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      // Native rendering needs a focused game; another test app can take the OS foreground.
      load("./services/warframeStatus.js").getStatus = async () => ({
        isOpen: true,
        isFocused: true,
        processRunning: true,
        focusedProcessName: "Warframe.x64.exe",
        focusedWindowBounds: null,
        focusedDisplayId: null,
        checkedAt: Date.now(),
      });
      load("./ipc/overlay/rivenScan.js").scanInitialCard = async () => [];
    });
    // A slow stylesheet must not let native readiness depend on the first layout frame.
    await harness.app.context().route("https://fonts.googleapis.com/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.abort();
    });
    await callMain(harness, "rivenOverlayIpc", "onRivenSessionOpen");
    for (const [kind, query] of [
      ["rivenLeft", "side=left"],
      ["rivenRight", "side=right"],
    ] as const) {
      const native = await overlayWindow(harness, query);
      await assertNativeLayout(native, kind, layouts[kind]!);
      expect(
        await evaluateInMain(
          harness.app,
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.webContents.getURL() === url)
              ?.isVisible(),
          native.url(),
        ),
      ).toBe(true);
      await expect(native.locator('[data-reward-field="weaponName"]')).toHaveCSS(
        "color",
        "rgb(51, 170, 255)",
      );
    }
    await callMain(harness, "rivenOverlayIpc", "onRivenSessionClose");
    await harness.app.context().unroute("https://fonts.googleapis.com/**");
    await callMain(harness, "arbiOverlayIpc", "maybeShowArbiSummary", summaryRun(0));
    const arbi = await overlayWindow(harness, "arbi-overlay.html");
    await assertNativeLayout(arbi, "arbiSummary", layouts.arbiSummary!);
    await expect(arbi.locator('[data-reward-field="actualVitusValue"]')).toHaveText("0");
    await expect(arbi.locator('[data-reward-field="vitusValue"]')).toHaveCSS(
      "color",
      "rgb(51, 170, 255)",
    );
    await callMain(harness, "arbiOverlayIpc", "maybeShowArbiSummary", summaryRun(null));
    await expect(arbi.locator('[data-reward-field="actualVitusValue"]')).toHaveText("?");
    await arbi.screenshot({ path: test.info().outputPath("arbiSummary-live-saved.png") });
    const arbiState = await readState(arbi);
    const baseArbiLayout = normalizeOverlayLayout("arbiSummary", undefined);
    for (const expanded of [false, true]) {
      const layout = structuredClone(baseArbiLayout);
      if (expanded)
        for (const field of Object.values(layout.fields)) if (field) field.hidden = false;
      await evaluateInMain(
        harness.app,
        ({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === payload.url)
            ?.webContents.send("overlay-edit-state", payload.state);
        },
        { url: arbi.url(), state: { ...arbiState, layout } },
      );
      await expect(arbi.locator("#kpi-grid .kpi:visible")).toHaveCount(expanded ? 9 : 4);
      if (expanded) {
        await arbi.locator("#kpi-grid .kpi:visible").last().scrollIntoViewIfNeeded();
        await expect(arbi.locator("#kpi-grid .kpi:visible").last()).toBeInViewport();
      }
      await nativeScreenshot(harness, arbi, `arbiSummary-${expanded ? "expanded" : "base"}.png`);
    }
    await callMain(
      harness,
      "tradeNotificationIpc",
      "showTradeNotification",
      {
        kind: "order",
        orderId: "fixture",
        itemName: "Braton Prime Receiver",
        itemUrlName: "braton_prime_receiver",
        itemThumb: null,
        quantity: 1,
        platinum: 42,
        partner: "FixtureTenno",
        type: "sale",
      },
      "closed",
    );
    const trade = await overlayWindow(harness, "trade-notification.html");
    await assertNativeLayout(trade, "tradeNotification", layouts.tradeNotification!);
    await expect(trade.locator('[data-reward-field="platinumValue"]')).toHaveText("+42");
    await expect(trade.locator('[data-reward-field="platinumValue"]')).toHaveCSS(
      "color",
      "rgb(51, 170, 255)",
    );
    await trade.screenshot({ path: test.info().outputPath("tradeNotification-live-saved.png") });
    expect(errors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
