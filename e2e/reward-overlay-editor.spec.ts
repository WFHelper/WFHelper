import fs from "node:fs";
import path from "node:path";

import { test, expect as baseExpect, type Frame, type Locator, type Page } from "@playwright/test";

import {
  REWARD_OVERLAY_CANVAS,
  type RewardOverlayLayout,
} from "../config/shared/rewardOverlayLayout";
import {
  DEFAULT_OVERLAY_FIELD_STYLE as DEFAULT_REWARD_FIELD_STYLE,
  normalizeOverlayLayout,
  type OverlayEditState,
  type OverlayLayoutKind,
} from "../config/shared/overlayLayout";
import { DEFAULT_THEME } from "../src/config/themeDefaults";
import type { ThemeSettings } from "../src/types/theme";
import {
  closeElectronTestHarness,
  dragRange,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  releaseRange,
  restartElectronTestHarness,
  setDisplayLanguage,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Separate Electron renderers can take longer to exchange layout state under parallel load.
const expect = baseExpect.configure({ timeout: 15_000 });

// Opt-in reward fields ship hidden, so an untouched or reset layout carries
// them rather than nothing at all.
const DEFAULT_REWARD_FIELDS = normalizeOverlayLayout("reward", undefined).fields;

function readState(overlay: Page | Frame): Promise<OverlayEditState> {
  return overlay.evaluate(() =>
    (
      window as unknown as {
        overlayLayoutApi: { getLayout: () => Promise<OverlayEditState> };
      }
    ).overlayLayoutApi.getLayout(),
  );
}

async function inputValue(control: Locator, value: string, expected = value): Promise<void> {
  await control.evaluate((element, next) => {
    (element as HTMLInputElement).value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await expect(control).toHaveValue(expected);
}

async function holdFirstEdit(overlay: Frame): Promise<void> {
  await overlay.evaluate(() => {
    const scope = window as unknown as {
      releaseEdit?: () => void;
      overlayLayoutApi: { editLayout: (token: string, command: unknown) => Promise<unknown> };
    };
    const edit = scope.overlayLayoutApi.editLayout;
    let hold = true;
    scope.overlayLayoutApi.editLayout = async (token, command) => {
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => {
          scope.releaseEdit = resolve;
          document.body.dataset.editHeld = "true";
        });
      }
      return edit(token, command);
    };
  });
}

async function clippedFields(overlay: Page | Frame): Promise<string[]> {
  return overlay.evaluate(() => {
    const panel = document.getElementById("panel")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>("[data-reward-field]"))
      .filter((element) => {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden")
          return false;
        const rect = element.getBoundingClientRect();
        const bounds = element.closest(".reward-slot")?.getBoundingClientRect() ?? panel;
        return (
          rect.left < bounds.left - 1 ||
          rect.top < bounds.top - 1 ||
          rect.right > bounds.right + 1 ||
          rect.bottom > bounds.bottom + 1
        );
      })
      .map((element) => element.dataset.rewardField!);
  });
}

async function editorFrame(page: Page): Promise<Frame> {
  await expect(page.locator("[data-reward-editor-frame]")).toBeVisible();
  const element = await page.locator("[data-reward-editor-frame]").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("Reward preview frame did not mount");
  await expect(frame.locator("body")).toHaveClass(/reward-layout-editing/);
  return frame;
}

async function rewardWindowCount(harness: ElectronTestHarness): Promise<number> {
  return evaluateInMain(
    harness.app,
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => {
        const url = window.webContents.getURL();
        return url.includes("renderer/overlay.html") && !url.includes("planner");
      }).length,
  );
}

async function openSettingsEditor(harness: ElectronTestHarness): Promise<Frame> {
  const { page } = harness;
  await page.locator('#sidebar [data-view="settings"]').click();
  await page.locator('[data-tour-tab="appearance"]').click();
  await page.locator('[data-appearance-tab="overlays"]').click();
  await page.locator('[data-overlay-editor-open="reward"]').click();
  await expect(page.locator("[data-reward-editor-scale]")).toBeVisible();
  const overlay = await editorFrame(page);
  await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
  expect(await rewardWindowCount(harness)).toBe(0);
  await expect(page.locator("[data-reward-editor-elements]")).not.toHaveAttribute("open", "");
  return overlay;
}

test("reward layout editing saves from Settings and opens from setup", async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-reward-editor-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page } = harness;
    await evaluateInMain(harness.app, ({ app, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.setAudioMuted(true);
      app.on("browser-window-created", (_event, window) => window.webContents.setAudioMuted(true));
    });

    let overlay = await openSettingsEditor(harness);
    const initial = await readState(overlay);
    expect(initial.sessionId).toBeTruthy();
    expect(initial.kind).toBe("reward");
    expect(initial.layout.fields).toEqual(DEFAULT_REWARD_FIELDS);

    await overlay.locator('[data-reward-field="rarity"]').first().click();
    await page.locator("[data-reward-editor-hidden]").check();
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();
    await page.locator("[data-reward-editor-cancel]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    await expect(page.locator("[data-reward-editor-frame]")).toHaveCount(0);

    overlay = await openSettingsEditor(harness);
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeVisible();
    expect((await readState(overlay)).layout.fields).toEqual(DEFAULT_REWARD_FIELDS);
    await page
      .locator("[data-reward-editor]")
      .screenshot({ path: testInfo.outputPath("reward-editor-default.png") });
    await expect.poll(() => clippedFields(overlay)).toEqual([]);
    await page.locator("[data-reward-editor-preview]").selectOption("rewards");
    const lastPart = overlay.locator('[data-reward-field="part5Count"]').first();
    await lastPart.scrollIntoViewIfNeeded();
    await expect(lastPart).toBeInViewport();
    await expect(overlay.locator("#best-footer")).toBeInViewport();
    await overlay.locator("#slots-grid").evaluate((element) => {
      element.scrollTop = 0;
    });

    await overlay.locator('[data-reward-field="rarity"]').first().click();
    await page.locator("[data-reward-editor-hidden]").check();
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();
    await overlay.locator('[data-reward-field="platinumValue"]').first().click();
    await page.locator("[data-reward-editor-elements] summary").click();
    await page.locator('[data-reward-editor-field="rarity"]').click();
    await page.locator("[data-reward-editor-hidden]").uncheck();
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeVisible();
    await page.locator("[data-reward-editor-hidden]").check();
    await page.locator("[data-reward-editor-elements] summary").click();

    await overlay.locator('[data-reward-field="platinumValue"]').first().click();
    for (const [value, bounded] of [
      ["99", 3],
      ["-1", 0.5],
    ] as const) {
      await inputValue(page.locator("[data-reward-editor-scale]"), value, String(bounded));
      await expect
        .poll(async () => (await readState(overlay)).layout.fields.platinumValue?.scale)
        .toBe(bounded);
      await expect(overlay.locator('[data-reward-field="platinumValue"]').first()).toHaveCSS(
        "scale",
        String(bounded),
      );
    }
    await page.locator('[data-reward-editor-position="x"]').fill("500");
    await page.locator('[data-reward-editor-position="x"]').dispatchEvent("change");
    await expect
      .poll(async () =>
        Number(await page.locator('[data-reward-editor-position="x"]').inputValue()),
      )
      .toBeLessThan(500);
    const constrained = (await readState(overlay)).layout.fields.platinumValue!;
    const renderedX = await overlay
      .locator('[data-reward-field="platinumValue"]')
      .first()
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).translate));
    expect(renderedX).toBeCloseTo(constrained.x, 2);
    await page.locator("[data-reward-editor-reset-field]").click();
    await overlay.locator('[data-reward-field="mastery"]').first().click();
    await inputValue(page.locator("[data-reward-editor-scale]"), "3");
    await expect.poll(() => clippedFields(overlay)).toEqual([]);
    await page.locator("[data-reward-editor-reset-field]").click();
    await overlay.locator('[data-reward-field="platinumValue"]').first().click();
    await inputValue(page.locator("[data-reward-editor-scale]"), "2");
    await expect
      .poll(() =>
        overlay
          .locator('[data-reward-field="platinumValue"]')
          .first()
          .evaluate((element) => Number(getComputedStyle(element).scale)),
      )
      .toBe(2);
    await overlay.locator('[data-reward-field="platinumIcon"]').first().click();
    await inputValue(page.locator("[data-reward-editor-color]"), "#ff0000");
    const icons = overlay.locator('[data-reward-field="platinumIcon"]');
    await expect(icons.first()).toHaveCSS("background-color", "rgb(255, 0, 0)");
    await expect(icons.first()).not.toHaveCSS("mask-image", "none");
    await expect(icons.first().locator("img")).toHaveCSS("visibility", "hidden");
    await page.locator("[data-reward-editor-reset-field]").click();
    await expect(icons.first()).toHaveCSS("mask-image", "none");
    await inputValue(page.locator("[data-reward-editor-color]"), "#ff0000");

    const priceToMove = overlay.locator(
      '.reward-slot[data-slot="0"] [data-reward-field="platinumValue"]',
    );
    await expect(priceToMove).toBeVisible();
    const box = await priceToMove.boundingBox();
    if (!box) throw new Error("Reward price has no bounds");
    const frameBox = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!frameBox) throw new Error("Reward canvas has no bounds");
    const canvasScale = frameBox.width / REWARD_OVERLAY_CANVAS.width;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 60 * canvasScale,
      box.y + box.height / 2 - 10 * canvasScale,
      { steps: 6 },
    );
    await page.mouse.up();
    await expect(page.locator('[data-reward-editor-field="platinumValue"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(async () => (await readState(overlay)).layout.fields.platinumValue?.x ?? 0)
      .toBeGreaterThan(20);
    const moved = (await readState(overlay)).layout.fields.platinumValue;
    expect(moved?.y).toBeLessThan(-4);
    // The price keeps its space and every card draws it from its own spot.
    const offsets = await cardTranslates(overlay, "platinumValue");
    expect(offsets.length).toBeGreaterThan(1);
    for (const offset of offsets) {
      const [x, y] = offset.split(" ").map(Number.parseFloat);
      expect(x).toBeCloseTo(moved!.x, 2);
      expect(y).toBeCloseTo(moved!.y, 2);
    }

    await page.locator("[data-reward-editor-count]").selectOption("1");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(1);
    for (const variant of ["missing", "scanning", "error"] as const) {
      await page.locator("[data-reward-editor-preview]").selectOption(variant);
      const selector =
        variant === "missing"
          ? '[data-reward-field="pricePlaceholder"]'
          : variant === "scanning"
            ? '[data-reward-field="scanText"]'
            : '[data-reward-field="errorText"]';
      await expect(overlay.locator(selector).first()).toBeVisible();
    }
    await page.locator("[data-reward-editor-preview]").selectOption("rewards");
    await page.locator("[data-reward-editor-count]").selectOption("4");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
    await expect(icons.first()).toHaveCSS("background-color", "rgb(255, 0, 0)");
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();

    for (const [value, bounded] of [
      ["99", 1.5],
      ["-1", 0.75],
    ] as const) {
      await inputValue(page.locator("[data-reward-editor-window-scale]"), value, String(bounded));
      await expect.poll(async () => (await readState(overlay)).scale).toBe(bounded);
    }
    await inputValue(page.locator("[data-reward-editor-window-scale]"), "0.85");
    await expect.poll(async () => (await readState(overlay)).scale).toBe(0.85);
    await page
      .locator("[data-reward-editor]")
      .screenshot({ path: testInfo.outputPath("reward-editor-customized.png") });
    await expect.poll(() => clippedFields(overlay)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("reward-editor-settings.png") });
    const edited = await readState(overlay);
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const settingsPath = path.join(harness.sandboxDir, "user-data", "overlay-settings.json");
    const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      rewardLayout: RewardOverlayLayout;
      overlayWindowScales: { reward: number };
    };
    expect(persisted.rewardLayout).toEqual(edited.layout);
    expect(persisted.overlayWindowScales.reward).toBe(0.85);

    await page.locator('[data-tour-tab="notifications"]').click();
    const notificationDuration = page.locator(
      '[data-setting="windows-notification-seconds"] input',
    );
    await notificationDuration.fill("17");
    await notificationDuration.press("Tab");
    await expect
      .poll(() => JSON.parse(fs.readFileSync(settingsPath, "utf8")).windowsNotificationSeconds)
      .toBe(17);
    const savedBySettings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof persisted;
    expect(savedBySettings.rewardLayout).toEqual(edited.layout);
    expect(savedBySettings.overlayWindowScales.reward).toBe(0.85);

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible();
    overlay = await openSettingsEditor(harness);
    expect((await readState(overlay)).layout).toEqual(edited.layout);
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();
    await page.locator("[data-reward-editor-reset]").click();
    await expect
      .poll(async () => (await readState(overlay)).layout.fields)
      .toEqual(DEFAULT_REWARD_FIELDS);
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeVisible();
    await page.locator("[data-reward-editor-cancel]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);

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
    await expect(page.locator('[data-placement-dummy="reward"]')).toBeVisible();
    await page.locator("[data-reward-editor-open]").click();
    await expect(page.locator("[data-reward-editor-scale]")).toBeVisible();
    overlay = await editorFrame(page);
    expect((await readState(overlay)).layout).toEqual(edited.layout);
    await page.screenshot({ path: testInfo.outputPath("reward-editor-setup.png") });
    await overlay.evaluate(() => {
      const api = (
        window as unknown as {
          overlayLayoutApi: { editLayout: (token: string, command: unknown) => Promise<unknown> };
        }
      ).overlayLayoutApi;
      const edit = api.editLayout;
      api.editLayout = async (token, command) => {
        const next = await edit(token, command);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return next;
      };
    });
    const labelBox = await overlay.locator('[data-reward-field="slotLabel"]').first().boundingBox();
    const previewBox = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!labelBox || !previewBox) throw new Error("Preview label is unavailable");
    // Ctrl turns snapping off, so the drag lands on the exact offset.
    await page.keyboard.down("Control");
    await page.mouse.move(labelBox.x + 3, labelBox.y + 3);
    await page.mouse.down();
    await page.mouse.move(
      labelBox.x + 3 + (30 * previewBox.width) / REWARD_OVERLAY_CANVAS.width,
      labelBox.y + 3,
      {
        steps: 6,
      },
    );
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const savedAfterDrag = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      rewardLayout: RewardOverlayLayout;
    };
    expect(savedAfterDrag.rewardLayout.fields.slotLabel?.x).toBeCloseTo(30, 0);
    expect(await rewardWindowCount(harness)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("preview variants and choice counts preserve a saved layout until it is edited", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  const rewardLayout = normalizeOverlayLayout("reward", {
    version: 1,
    fields: { platinumValue: { x: 500, y: 0, scale: 2 } },
  });
  try {
    harness = await launchElectronTestHarness("wfh-reward-editor-preview-", {
      userDataFiles: {
        "overlay-settings.json": { notificationSoundEnabled: false, rewardLayout },
      },
    });
    const { page } = harness;
    const overlay = await openSettingsEditor(harness);
    expect((await readState(overlay)).layout).toEqual(rewardLayout);
    await page.locator("[data-reward-editor-count]").selectOption("1");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(1);
    await page.locator("[data-reward-editor-preview]").selectOption("error");
    await expect(overlay.locator("#error-banner")).toBeVisible();
    await page.locator("[data-reward-editor-preview]").selectOption("rewards");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(1);
    expect((await readState(overlay)).layout).toEqual(rewardLayout);
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const saved = JSON.parse(
      fs.readFileSync(path.join(harness.sandboxDir, "user-data", "overlay-settings.json"), "utf8"),
    ) as { rewardLayout: RewardOverlayLayout };
    expect(saved.rewardLayout).toEqual(rewardLayout);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("acknowledged drag steps keep the original preview node and pointer capture", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-reward-editor-capture-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    const { page } = harness;
    const overlay = await openSettingsEditor(harness);
    const target = overlay.locator('[data-reward-field="platinumValue"]').first();
    const original = await target.elementHandle();
    const box = await target.boundingBox();
    const preview = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!original || !box || !preview) throw new Error("Preview field is unavailable");
    const scale = preview.width / REWARD_OVERLAY_CANVAS.width;
    await overlay.evaluate(() => {
      document.body.dataset.previewConfigurations = "0";
      window.addEventListener("message", (event) => {
        if (event.data?.type === "reward-preview-config")
          document.body.dataset.previewConfigurations = String(
            Number(document.body.dataset.previewConfigurations) + 1,
          );
      });
    });
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + 3, box.y + 3);
    await page.mouse.down();
    for (const offset of [10, 20, 30]) {
      await page.mouse.move(box.x + 3 + offset * scale, box.y + 3);
      await expect(page.locator('[data-reward-editor-position="x"]')).toHaveValue(String(offset));
      await overlay.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await original.evaluate((element) => element.isConnected)).toBe(true);
    }
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect(overlay.locator("body")).toHaveAttribute("data-preview-configurations", "0");
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const saved = JSON.parse(
      fs.readFileSync(path.join(harness.sandboxDir, "user-data", "overlay-settings.json"), "utf8"),
    ) as { rewardLayout: RewardOverlayLayout };
    expect(saved.rewardLayout.fields.platinumValue?.x).toBe(30);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

for (const [source, control, laterSelection] of [
  ["preview", "hidden", null],
  ["preview", "reset-field", null],
  ["preview", "hidden", "preview"],
  ["elements", "hidden", null],
  ["elements", "reset-field", null],
  ["elements", "hidden", "preview"],
  ["preview", "hidden", "elements"],
] as const) {
  test(`${control} keeps its pending ${source} selection${laterSelection ? ` before another ${laterSelection} selection` : ""}`, async () => {
    test.setTimeout(120_000);
    let harness: ElectronTestHarness | undefined;
    try {
      harness = await launchElectronTestHarness("wfh-reward-editor-selection-", {
        userDataFiles: {
          "overlay-settings.json": {
            notificationSoundEnabled: false,
            rewardLayout: {
              version: 1,
              fields: { rarity: { x: 23 }, platinumValue: { x: 11 } },
            },
          },
        },
      });
      const { page } = harness;
      const overlay = await openSettingsEditor(harness);
      const selectField = async (field: string, from: "preview" | "elements") => {
        if (from === "preview") {
          await overlay.locator(`[data-reward-field="${field}"]`).first().click();
        } else {
          const elements = page.locator("[data-reward-editor-elements]");
          if ((await elements.getAttribute("open")) === null) {
            await elements.locator("summary").click();
          }
          await page.locator(`[data-reward-editor-field="${field}"]`).click();
        }
      };
      await holdFirstEdit(overlay);
      await selectField("rarity", source);
      await expect(overlay.locator("body")).toHaveAttribute("data-edit-held", "true");
      if (control !== "reset-field") await page.locator("[data-reward-editor-hidden]").check();
      else await page.locator("[data-reward-editor-reset-field]").click();
      if (laterSelection) await selectField("ducatValue", laterSelection);
      await overlay.evaluate(() => {
        (window as unknown as { releaseEdit: () => void }).releaseEdit();
      });
      const finalSelection = laterSelection ? "ducatValue" : "rarity";
      await expect(page.locator(`[data-reward-editor-field="${finalSelection}"]`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.locator("[data-reward-editor-save]").click();
      await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(harness.sandboxDir, "user-data", "overlay-settings.json"),
          "utf8",
        ),
      ) as { rewardLayout: RewardOverlayLayout };
      if (control !== "reset-field") {
        expect(saved.rewardLayout.fields.rarity?.hidden).toBe(true);
        expect(saved.rewardLayout.fields.rarity?.x).toBe(23);
      } else {
        expect(saved.rewardLayout.fields.rarity?.x ?? 0).toBe(0);
      }
      expect(saved.rewardLayout.fields.platinumValue?.x).toBe(11);
      expect(saved.rewardLayout.fields.platinumValue?.hidden ?? false).toBe(false);
      expect(saved.rewardLayout.fields.ducatValue?.hidden ?? false).toBe(false);
    } finally {
      await closeElectronTestHarness(harness);
    }
  });
}

test("rapid field selection and a refused drag preserve the last position on Save", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-reward-editor-queue-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page } = harness;
    let overlay = await openSettingsEditor(harness);
    await holdFirstEdit(overlay);
    const labelBox = await overlay.locator('[data-reward-field="slotLabel"]').first().boundingBox();
    const previewBox = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!labelBox || !previewBox) throw new Error("Preview label is unavailable");
    await page.keyboard.down("Control");
    await page.mouse.move(labelBox.x + 3, labelBox.y + 3);
    await page.mouse.down();
    await expect(overlay.locator("body")).toHaveAttribute("data-edit-held", "true");
    await page.mouse.move(
      labelBox.x + 3 + (30 * previewBox.width) / REWARD_OVERLAY_CANVAS.width,
      labelBox.y + 3,
    );
    await page.mouse.up();
    await page.keyboard.up("Control");
    await overlay.locator('[data-reward-field="ducatValue"]').first().click();
    await overlay.evaluate(() => {
      (window as unknown as { releaseEdit: () => void }).releaseEdit();
    });
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const settingsPath = path.join(harness.sandboxDir, "user-data", "overlay-settings.json");
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      rewardLayout: RewardOverlayLayout;
    };
    expect(saved.rewardLayout.fields.slotLabel?.x).toBeCloseTo(30, 0);

    overlay = await openSettingsEditor(harness);
    await overlay.evaluate(() => {
      const scope = window as unknown as {
        refuseEdits: boolean;
        overlayLayoutApi: {
          editLayout: (token: string, command: { type: string }) => Promise<unknown>;
        };
      };
      const edit = scope.overlayLayoutApi.editLayout;
      scope.refuseEdits = true;
      scope.overlayLayoutApi.editLayout = async (token, command) => {
        if (command.type === "field" && scope.refuseEdits) {
          document.body.dataset.editRefused = "true";
          throw new Error("Injected unavailable editor command");
        }
        return edit(token, command);
      };
    });
    const priceBox = await overlay
      .locator('[data-reward-field="platinumValue"]')
      .first()
      .boundingBox();
    const secondPreviewBox = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!priceBox || !secondPreviewBox) throw new Error("Preview price is unavailable");
    await page.keyboard.down("Control");
    await page.mouse.move(priceBox.x + 3, priceBox.y + 3);
    await page.mouse.down();
    await page.mouse.move(
      priceBox.x + 3 + (20 * secondPreviewBox.width) / REWARD_OVERLAY_CANVAS.width,
      priceBox.y + 3,
    );
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect(overlay.locator("body")).toHaveAttribute("data-edit-refused", "true");
    await overlay.evaluate(() => {
      (window as unknown as { refuseEdits: boolean }).refuseEdits = false;
    });
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const retried = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof saved;
    expect(retried.rewardLayout.fields.platinumValue?.x).toBeCloseTo(20, 0);
    expect(retried.rewardLayout.fields.slotLabel?.x).toBeCloseTo(30, 0);

    overlay = await openSettingsEditor(harness);
    await holdFirstEdit(overlay);
    const resetLabelBox = await overlay
      .locator('[data-reward-field="slotLabel"]')
      .first()
      .boundingBox();
    const resetPreviewBox = await page.locator("[data-reward-editor-frame]").boundingBox();
    if (!resetLabelBox || !resetPreviewBox) throw new Error("Preview label is unavailable");
    await page.mouse.move(resetLabelBox.x + 3, resetLabelBox.y + 3);
    await page.mouse.down();
    await expect(overlay.locator("body")).toHaveAttribute("data-edit-held", "true");
    await page.mouse.move(
      resetLabelBox.x + 3 + (20 * resetPreviewBox.width) / REWARD_OVERLAY_CANVAS.width,
      resetLabelBox.y + 3,
    );
    await page.mouse.up();
    await page.locator("[data-reward-editor-reset]").click();
    await overlay.evaluate(() => {
      (window as unknown as { releaseEdit: () => void }).releaseEdit();
    });
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const resetAfterDrag = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof saved;
    expect(resetAfterDrag.rewardLayout.fields).toEqual(DEFAULT_REWARD_FIELDS);
    expect(errors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("saved reward fields survive a fresh process, live prices and language changes", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  const base = DEFAULT_REWARD_FIELD_STYLE;
  const layout: RewardOverlayLayout = {
    version: 1,
    fields: {
      rarity: { ...base, hidden: true },
      platinumValue: { ...base, scale: 1.5, color: "#33aaff" },
    },
  };
  try {
    harness = await launchElectronTestHarness("wfh-reward-saved-", {
      userDataFiles: {
        "overlay-settings.json": { notificationSoundEnabled: false, rewardLayout: layout },
      },
    });
    await evaluateInMain(harness.app, ({ ipcMain, BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.setAudioMuted(true);
      ipcMain.removeHandler("overlay:get-price");
      ipcMain.handle("overlay:get-price", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 42;
      });
    });
    await harness.page.evaluate(() => window.api.toggleOverlay());
    const overlay = await overlayWindow(harness, "renderer/overlay.html", "planner");
    await expect
      .poll(async () => (await readState(overlay)).layout)
      .toEqual(normalizeOverlayLayout("reward", layout));
    expect((await readState(overlay)).sessionId).toBeNull();
    expect(
      await overlay.evaluate(() =>
        Object.keys((window as unknown as { overlayLayoutApi: object }).overlayLayoutApi).sort(),
      ),
    ).toEqual(["defaultFieldStyle", "getLayout", "onLayout"]);
    await expect(overlay.locator("body")).not.toHaveClass(/reward-layout-editing/);
    await expect(overlay.locator('[data-reward-field="slotLabel"]').first()).toBeAttached();
    await evaluateInMain(harness.app, ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => {
        const url = candidate.webContents.getURL();
        return url.includes("renderer/overlay.html") && !url.includes("planner");
      });
      win?.webContents.send(
        "relic-reward-items",
        Array.from({ length: 4 }, (_, slotIndex) => ({
          slotIndex,
          name: "Braton Prime Receiver",
          urlName: "fixture_reward",
          rarity: "rare",
          ducats: 100,
        })),
      );
    });
    const price = overlay.locator('[data-reward-field="platinumValue"]').first();
    await expect(price).toHaveText("42");
    await expect(price).toHaveCSS("scale", "1.5");
    await expect(price).toHaveCSS("color", "rgb(51, 170, 255)");
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();
    await setDisplayLanguage(harness.page, "de");
    await expect(overlay.locator('[data-reward-field="slotLabel"]').first()).toHaveText("Platz 1");
    await expect(price).toHaveCSS("scale", "1.5");
    await expect(price).toHaveCSS("color", "rgb(51, 170, 255)");
    await expect(overlay.locator('[data-reward-field="rarity"]').first()).toBeHidden();
    await expect(overlay.locator(".reward-slot.has-item .slot-name")).toHaveText(
      Array(4).fill("Braton Prime Receiver"),
    );
    const geometry = await overlay.locator(".reward-slot").evaluateAll((cards) =>
      cards.map((card) => ({
        card: card.getBoundingClientRect().toJSON(),
        label: card.querySelector(".slot-player")?.getBoundingClientRect().toJSON(),
        name: card.querySelector(".slot-name")?.getBoundingClientRect().toJSON(),
      })),
    );
    for (const { card, label, name } of geometry) {
      expect(label?.left).toBeGreaterThanOrEqual(card.left);
      expect(name?.left).toBeGreaterThanOrEqual(card.left);
      expect(name?.right).toBeLessThanOrEqual(card.right);
    }
    await overlay.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await overlay.screenshot({ path: test.info().outputPath("reward-layout-live-saved.png") });
  } finally {
    await closeElectronTestHarness(harness);
  }
});

interface SlotSpot {
  slot: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function slotSpots(surface: Page | Frame, field: string): Promise<SlotSpot[]> {
  return surface.locator(`.reward-slot [data-reward-field="${field}"]`).evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const card = element.closest<HTMLElement>(".reward-slot")!;
        const bounds = card.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return {
          slot: Number(card.dataset.slot),
          left: rect.left - bounds.left,
          top: rect.top - bounds.top,
          right: rect.right - bounds.left,
          bottom: rect.bottom - bounds.top,
        };
      }),
  );
}

function cardTranslates(surface: Page | Frame, field: string): Promise<string[]> {
  return surface
    .locator(`.reward-slot [data-reward-field="${field}"]`)
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => getComputedStyle(element).translate),
    );
}

function expectOneSpot(spots: SlotSpot[], label: string, cards: number): void {
  expect(spots.map((spot) => spot.slot)).toHaveLength(cards);
  for (const spot of spots) {
    expect(Math.abs(spot.left - spots[0].left), `${label} left on slot ${spot.slot}`).toBeLessThan(
      1,
    );
    expect(Math.abs(spot.top - spots[0].top), `${label} top on slot ${spot.slot}`).toBeLessThan(1);
  }
}

async function previewZoom(page: Page): Promise<number> {
  const frame = page.locator("[data-reward-editor-frame]");
  const box = await frame.boundingBox();
  const width = await frame.evaluate((element) => (element as HTMLElement).offsetWidth);
  if (!box || !width) throw new Error("Preview frame has no bounds");
  return box.width / width;
}

async function dragField(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  options: { modifier?: "Alt" | "Control"; hold?: boolean } = {},
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("Dragged field has no bounds");
  const zoom = await previewZoom(page);
  const x = box.x + Math.min(6, box.width / 2);
  const y = box.y + box.height / 2;
  if (options.modifier) await page.keyboard.down(options.modifier);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * zoom, y + dy * zoom, { steps: 8 });
  if (options.hold) return;
  await page.mouse.up();
  if (options.modifier) await page.keyboard.up(options.modifier);
}

function rewardItem(slotIndex: number, building: boolean) {
  return {
    slotIndex,
    name: "Lex Prime Barrel",
    urlName: "fixture_part",
    rarity: "uncommon",
    ducats: 45,
    partOwnedCount: 1,
    partRequiredCount: 1,
    mastered: true,
    building,
    setOwnedCount: 2,
    setRequiredCount: 3,
    setUrlName: "fixture_set",
    setParts: ["Blueprint", "Barrel", "Receiver"].map((name, part) => ({
      name,
      ownedCount: part === 2 ? 0 : 1,
      requiredCount: 1,
      isReward: part === 1,
      building: building && part === 1,
    })),
  };
}

async function showLiveRewards(
  harness: ElectronTestHarness,
  items: ReturnType<typeof rewardItem>[],
): Promise<Page> {
  await evaluateInMain(harness.app, ({ ipcMain }) => {
    ipcMain.removeHandler("overlay:get-price");
    ipcMain.handle("overlay:get-price", async () => 42);
    const scope = globalThis as { rewardPresented?: boolean };
    scope.rewardPresented = false;
    ipcMain.once("relic-reward-presentation", () => {
      scope.rewardPresented = true;
    });
  });
  await harness.page.evaluate(() => window.api.toggleOverlay());
  const live = await overlayWindow(harness, "renderer/overlay.html", "planner");
  await expect(live.locator('[data-reward-field="slotLabel"]').first()).toBeAttached();
  await evaluateInMain(
    harness.app,
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => {
          const url = candidate.webContents.getURL();
          return url.includes("renderer/overlay.html") && !url.includes("planner");
        })
        ?.webContents.send("relic-reward-items", payload);
    },
    items,
  );
  await expect(live.locator('.reward-slot [data-reward-field="setPrice"]')).toHaveText(
    Array(items.length).fill(/42/),
  );
  await expect
    .poll(() =>
      evaluateInMain(
        harness.app,
        () => (globalThis as { rewardPresented?: boolean }).rewardPresented,
      ),
    )
    .toBe(true);
  await live.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return live;
}

test("hidden fields take no space and a dragged chip keeps one spot on every card", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-reward-arrange-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page } = harness;
    const overlay = await openSettingsEditor(harness);
    await expect(page.locator("[data-reward-editor-preview]")).toHaveValue("mixed");
    const canvas = page.locator("[data-reward-editor-canvas]");
    await canvas.screenshot({ path: test.info().outputPath("editor-preview-default.png") });

    const [foundry] = await slotSpots(overlay, "foundry");
    expect(foundry?.slot).toBe(2);
    await overlay.locator('[data-reward-field="foundry"]').click();
    await page.locator("[data-reward-editor-hidden]").check();
    await expect(overlay.locator('[data-reward-field="foundry"]')).toBeHidden();
    await expect
      .poll(async () => (await slotSpots(overlay, "foundry")).length, "hidden chip keeps a box")
      .toBe(0);
    const reflowed = (await slotSpots(overlay, "setOwned")).find((spot) => spot.slot === 2)!;
    expect(Math.abs(reflowed.left - foundry.left), "set chip fills the hidden chip").toBeLessThan(
      1,
    );
    expect(Math.abs(reflowed.top - foundry.top)).toBeLessThan(1);
    await canvas.screenshot({ path: test.info().outputPath("editor-foundry-hidden.png") });

    const before = await slotSpots(overlay, "setOwned");
    const priceBefore = await slotSpots(overlay, "setPrice");
    expect(before.map((spot) => spot.slot)).toEqual([0, 2, 3]);
    await dragField(
      page,
      overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="setOwned"]'),
      36,
      -28,
      { modifier: "Control" },
    );
    await expect
      .poll(async () => (await readState(overlay)).layout.fields.setOwned?.y ?? 0)
      .toBeLessThan(-20);
    const dragged = await slotSpots(overlay, "setOwned");
    expectOneSpot(dragged, "dragged set chip", 3);
    expect(dragged[0].left).toBeGreaterThan(before[0].left + 30);
    const priceAfter = (await slotSpots(overlay, "setPrice")).find((spot) => spot.slot === 0)!;
    expect(priceBefore[0].left - priceAfter.left, "the moved chip leaves no gap").toBeGreaterThan(
      before[0].right - before[0].left,
    );
    await canvas.screenshot({ path: test.info().outputPath("editor-set-chip-dragged.png") });
    const edited = (await readState(overlay)).layout;
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);

    const live = await showLiveRewards(
      harness,
      [0, 1, 2, 3].map((slot) => rewardItem(slot, slot === 2)),
    );
    expect((await readState(live)).layout).toEqual(edited);
    expect(await slotSpots(live, "foundry")).toEqual([]);
    expectOneSpot(await slotSpots(live, "setPrice"), "set price after a hidden chip", 4);
    expectOneSpot(await slotSpots(live, "setOwned"), "live dragged set chip", 4);
    const metaHeights = await live
      .locator(".slot-meta")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(new Set(metaHeights).size, "a hidden chip wrapped a row").toBe(1);
    await live.screenshot({ path: test.info().outputPath("live-overlay-arranged.png") });
    for (const size of [
      { logicalWidth: 1029, zoom: 1.3 },
      { logicalWidth: 980, zoom: 0.8 },
    ]) {
      await evaluateInMain(
        harness.app,
        ({ app, screen }, next) => {
          const load = process
            .getBuiltinModule("module")
            .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
          const ctx = (load("./ipc/context.js") as typeof import("../ipc/context")).default;
          const { baseZoomForDisplay } = load(
            "./config/runtime/uiScale.js",
          ) as typeof import("../config/runtime/uiScale");
          const display = screen.getPrimaryDisplay();
          ctx.overlaySettings = {
            ...ctx.overlaySettings,
            overlayWindowBounds: {
              ...ctx.overlaySettings.overlayWindowBounds,
              reward: {
                x: 0,
                y: 0,
                displayId: String(display.id),
                width: next.logicalWidth,
                height: 360,
              },
            },
            overlayWindowScales: {
              ...ctx.overlaySettings.overlayWindowScales,
              reward: next.zoom / baseZoomForDisplay(display.workArea),
            },
          };
          (
            load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc")
          ).rewardWindowsController.positionOverlayWindow();
        },
        size,
      );
      await expect.poll(() => live.evaluate(() => window.innerWidth)).toBe(size.logicalWidth);
      await expect(async () => {
        expectOneSpot(await slotSpots(live, "setPrice"), `set price at ${size.zoom}`, 4);
        expectOneSpot(await slotSpots(live, "setOwned"), `set chip at ${size.zoom}`, 4);
      }).toPass({ timeout: 15_000 });
    }
    expect(errors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

function slotSpot(surface: Page | Frame, field: string, slot: number): Promise<SlotSpot> {
  return slotSpots(surface, field).then((spots) => {
    const spot = spots.find((entry) => entry.slot === slot);
    if (!spot) throw new Error(`${field} is not on slot ${slot}`);
    return spot;
  });
}

test("the editor moves one card, snaps to guides, aligns a selection, nudges and undoes", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-reward-tools-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page } = harness;
    let overlay = await openSettingsEditor(harness);
    await page.locator("[data-reward-editor-preview]").selectOption("rewards");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
    const canvas = page.locator("[data-reward-editor-canvas]");
    const fields = async () => (await readState(overlay)).layout.fields;

    const ownedBefore = await slotSpots(overlay, "owned");
    expect(ownedBefore).toHaveLength(4);
    await page.locator('[data-reward-editor-scope="card"]').click();
    await dragField(
      page,
      overlay.locator('.reward-slot[data-slot="2"] [data-reward-field="owned"]'),
      40,
      -22,
      { modifier: "Control" },
    );
    await expect.poll(async () => (await fields()).owned?.cards?.["2"]).toEqual({ x: 40, y: -22 });
    expect([(await fields()).owned?.x, (await fields()).owned?.y]).toEqual([0, 0]);
    for (const spot of await slotSpots(overlay, "owned")) {
      const before = ownedBefore.find((entry) => entry.slot === spot.slot)!;
      const moved = spot.slot === 2 ? [40, -22] : [0, 0];
      expect(Math.abs(spot.left - before.left - moved[0]), `owned x on ${spot.slot}`).toBeLessThan(
        1,
      );
      expect(Math.abs(spot.top - before.top - moved[1]), `owned y on ${spot.slot}`).toBeLessThan(1);
    }
    await canvas.screenshot({ path: test.info().outputPath("editor-one-card-override.png") });

    await page.locator('[data-reward-editor-scope="all"]').click();
    await dragField(
      page,
      overlay.locator('.reward-slot[data-slot="1"] [data-reward-field="owned"]'),
      24,
      6,
      { modifier: "Alt" },
    );
    await expect.poll(async () => (await fields()).owned?.cards?.["1"]).toBeTruthy();
    await expect(page.locator("[data-reward-editor-reset-card]")).toBeEnabled();
    await page.locator("[data-reward-editor-reset-card]").click();
    await expect.poll(async () => Object.keys((await fields()).owned?.cards ?? {})).toEqual(["2"]);
    expect(Math.abs((await slotSpot(overlay, "owned", 1)).left - ownedBefore[1].left)).toBeLessThan(
      1,
    );

    // The rarity tag leaves the flow without moving anything else, so the lines
    // measured before the drag are the lines it can snap to.
    const rarity = overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="rarity"]');
    const snapLines = await overlay.locator('.reward-slot[data-slot="0"]').evaluate((card) => {
      const bounds = card.getBoundingClientRect();
      const styles = getComputedStyle(card);
      const left = card.clientLeft + Number.parseFloat(styles.paddingLeft);
      const right = card.clientLeft + card.clientWidth - Number.parseFloat(styles.paddingRight);
      const lines = [left, (left + right) / 2, right];
      for (const element of Array.from(card.querySelectorAll<HTMLElement>("[data-reward-field]"))) {
        if (element.dataset.rewardField === "rarity" || !element.getClientRects().length) continue;
        const rect = element.getBoundingClientRect();
        const x = rect.left - bounds.left;
        lines.push(x, x + rect.width / 2, x + rect.width);
      }
      return { lines, width: bounds.width };
    });
    const tag = await slotSpot(overlay, "rarity", 0);
    const tagWidth = tag.right - tag.left;
    // A drop 2 px beside one line with no other line as close.
    const plan = snapLines.lines
      .flatMap((target) =>
        [0, 0.5, 1].flatMap((edge) =>
          [2, -2].map((miss) => ({ target, edge, left: target - edge * tagWidth + miss })),
        ),
      )
      .find(({ target, left }) => {
        if (left < 40 || left + tagWidth > snapLines.width - 8) return false;
        const own = [left, left + tagWidth / 2, left + tagWidth];
        const near = new Set(
          snapLines.lines
            .filter((line) => own.some((x) => Math.abs(line - x) <= 2.5))
            .map((line) => Math.round(line * 10)),
        );
        return near.size === 1 && near.has(Math.round(target * 10));
      });
    if (!plan) throw new Error("No unambiguous snap line on the first card");
    await dragField(page, rarity, plan.left - tag.left, 0, { hold: true });
    const guides = overlay.locator(".reward-layout-guide");
    await expect(guides).not.toHaveCount(0);
    const cardLeft = await overlay
      .locator('.reward-slot[data-slot="0"]')
      .evaluate((card) => card.getBoundingClientRect().left);
    const guideXs = await guides.evaluateAll(
      (lines, left) =>
        lines
          .map((line) => line.getBoundingClientRect())
          .filter((rect) => rect.height > rect.width)
          .map((rect) => rect.left - left),
      cardLeft,
    );
    expect(guideXs, "a vertical guide on the snapped line").toHaveLength(1);
    expect(Math.abs(guideXs[0] - plan.target)).toBeLessThan(0.5);
    await canvas.screenshot({ path: test.info().outputPath("editor-snap-guides.png") });
    await page.mouse.up();
    await expect(guides).toHaveCount(0);
    const snapped = await slotSpot(overlay, "rarity", 0);
    expect(
      Math.abs(snapped.left + plan.edge * tagWidth - plan.target),
      "the drop lands exactly on the guide",
    ).toBeLessThan(0.5);
    expectOneSpot(await slotSpots(overlay, "rarity"), "snapped rarity", 4);
    await dragField(page, rarity, 2, 0, { modifier: "Control" });
    await expect
      .poll(async () => {
        const free = await slotSpot(overlay, "rarity", 0);
        return Math.round((free.left - snapped.left) * 10) / 10;
      }, "Ctrl turns snapping off")
      .toBe(2);

    await overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="platinumIcon"]').click();
    await overlay
      .locator('.reward-slot[data-slot="0"] [data-reward-field="setPrice"]')
      .click({ modifiers: ["Shift"] });
    await expect
      .poll(async () => (await readState(overlay)).selectedFields)
      .toEqual(["platinumIcon", "setPrice"]);
    await expect(page.locator('[data-reward-editor-field="platinumIcon"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-reward-editor-field="setPrice"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const icons = await slotSpots(overlay, "platinumIcon");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => (await fields()).setPrice?.y).toBe(10);
    const nudged = await fields();
    for (const field of ["platinumIcon", "setPrice"] as const)
      expect([nudged[field]?.x, nudged[field]?.y], `${field} nudge`).toEqual([1, 10]);

    await page.locator('[data-reward-editor-align="left"]').click();
    await expect
      .poll(
        async () =>
          Math.abs(
            (await slotSpot(overlay, "platinumIcon", 0)).left -
              (await slotSpot(overlay, "setPrice", 0)).left,
          ),
        "left edges on the picked card",
      )
      .toBeLessThan(0.5);
    // The icon is a block, so the other cards move it by the same offset from its own spot.
    const alignedIcons = await slotSpots(overlay, "platinumIcon");
    expect(alignedIcons.map((spot) => spot.slot)).toEqual([0, 2, 3]);
    for (const [index, spot] of alignedIcons.entries()) {
      for (const edge of ["left", "top"] as const) {
        const move = spot[edge] - icons[index][edge];
        const picked = alignedIcons[0][edge] - icons[0][edge];
        expect(Math.abs(move - picked), `icon ${edge} on slot ${spot.slot}`).toBeLessThan(0.5);
      }
    }
    const aligned = await fields();
    await page.keyboard.press("Control+z");
    await expect.poll(fields).toEqual(nudged);
    await page.locator("[data-reward-editor-undo]").click();
    await page.locator("[data-reward-editor-undo]").click();
    await expect.poll(async () => (await fields()).setPrice).toBeUndefined();
    expect((await fields()).platinumIcon).toBeUndefined();
    await overlay.locator('.reward-slot[data-slot="1"]').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(fields).toEqual(nudged);
    await page.locator('[data-reward-editor-align="left"]').click();
    await expect.poll(fields).toEqual(aligned);
    await canvas.screenshot({ path: test.info().outputPath("editor-aligned-selection.png") });
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const settingsPath = path.join(harness.sandboxDir, "user-data", "overlay-settings.json");
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      rewardLayout: RewardOverlayLayout;
    };
    expect(saved.rewardLayout.fields.owned?.cards).toEqual({ "2": { x: 40, y: -22 } });

    const live = await showLiveRewards(
      harness,
      [0, 1, 2, 3].map((slot) => rewardItem(slot, false)),
    );
    await live.screenshot({ path: test.info().outputPath("live-overlay-tools.png") });
    overlay = await openOverlayEditor(page, "reward");
    await expect(page.locator('[data-reward-editor-preview] option[value="last"]')).toBeAttached();
    await page.locator("[data-reward-editor-preview]").selectOption("last");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
    for (const field of ["owned", "rarity", "platinumIcon", "setPrice"]) {
      const shown = await slotSpots(overlay, field);
      const rendered = await slotSpots(live, field);
      expect(rendered, `${field} renders on the live cards`).toHaveLength(shown.length);
      for (const [index, spot] of rendered.entries()) {
        expect(Math.abs(spot.left - shown[index].left), `${field} x live/editor`).toBeLessThan(1);
        expect(Math.abs(spot.top - shown[index].top), `${field} y live/editor`).toBeLessThan(1);
      }
    }
    const liveOwned = await slotSpots(live, "owned");
    expect(Math.abs(liveOwned[2].left - liveOwned[0].left - 40)).toBeLessThan(1);

    await overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="rarity"]').click();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await fields()).rarity?.x)
      .toBeCloseTo((saved.rewardLayout.fields.rarity?.x ?? 0) + 1, 2);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    expect(
      (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as typeof saved).rewardLayout,
    ).toEqual(saved.rewardLayout);
    expect(errors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("a layout saved before card offsets loads unchanged and lines moved chips up", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  const base = DEFAULT_REWARD_FIELD_STYLE;
  const legacy = {
    version: 1,
    fields: {
      setOwned: { ...base, x: 24, y: -30 },
      platinumValue: { ...base, x: -12, y: 4, scale: 1.2, color: "#33aaff" },
      rarity: { ...base, hidden: true },
    },
  };
  try {
    harness = await launchElectronTestHarness("wfh-reward-legacy-", {
      userDataFiles: {
        "overlay-settings.json": { notificationSoundEnabled: false, rewardLayout: legacy },
      },
    });
    const { page } = harness;
    const overlay = await openSettingsEditor(harness);
    const expected = normalizeOverlayLayout("reward", legacy);
    expect((await readState(overlay)).layout).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain("cards");
    expectOneSpot(await slotSpots(overlay, "setOwned"), "legacy set chip", 3);
    // The price keeps its space and every card draws it from its own spot.
    await expect
      .poll(() => cardTranslates(overlay, "platinumValue"))
      .toEqual(Array(3).fill("-12px 4px"));
    await page.locator("[data-reward-editor-save]").click();
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    const saved = JSON.parse(
      fs.readFileSync(path.join(harness.sandboxDir, "user-data", "overlay-settings.json"), "utf8"),
    ) as { rewardLayout: RewardOverlayLayout };
    expect(saved.rewardLayout).toEqual(expected);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

// Every rendered field on every card, relative to its card, plus each card's height.
function cardGeometry(surface: Page | Frame, except: string): Promise<Record<string, number>> {
  return surface.locator(".reward-slot").evaluateAll((cards, skip) => {
    const geometry: Record<string, number> = {};
    for (const card of cards as HTMLElement[]) {
      if (!card.getClientRects().length) continue;
      const bounds = card.getBoundingClientRect();
      geometry[`${card.dataset.slot} height`] = bounds.height;
      for (const element of Array.from(card.querySelectorAll<HTMLElement>("[data-reward-field]"))) {
        if (element.dataset.rewardField === skip || !element.getClientRects().length) continue;
        const rect = element.getBoundingClientRect();
        const key = `${card.dataset.slot} ${element.dataset.rewardField}`;
        geometry[`${key} left`] = rect.left - bounds.left;
        geometry[`${key} top`] = rect.top - bounds.top;
      }
    }
    return geometry;
  }, except);
}

function expectSameGeometry(
  actual: Record<string, number>,
  expected: Record<string, number>,
  label: string,
): void {
  expect(Object.keys(actual).sort(), `${label}: rendered fields`).toEqual(
    Object.keys(expected).sort(),
  );
  for (const [key, value] of Object.entries(expected))
    expect(Math.abs(actual[key] - value), `${label}: ${key}`).toBeLessThanOrEqual(1);
}

test("a moved block row keeps the card body in place, also for an old name offset", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  const legacy = {
    version: 1,
    fields: { itemName: { ...DEFAULT_REWARD_FIELD_STYLE, x: 4, y: 9 } },
  };
  try {
    harness = await launchElectronTestHarness("wfh-reward-block-", {
      userDataFiles: {
        "overlay-settings.json": { notificationSoundEnabled: false, rewardLayout: legacy },
      },
    });
    const { page } = harness;
    const overlay = await openSettingsEditor(harness);
    const fields = async () => (await readState(overlay)).layout.fields;
    const legacyRows = await cardGeometry(overlay, "itemName");
    const legacyNames = await slotSpots(overlay, "itemName");
    expectOneSpot(legacyNames, "old name offset", 4);

    const name = overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="itemName"]');
    await name.click();
    await page.locator("[data-reward-editor-reset-field]").click();
    await expect.poll(async () => (await fields()).itemName?.x ?? 0).toBe(0);
    await expect(async () => {
      expectSameGeometry(await cardGeometry(overlay, "itemName"), legacyRows, "old name offset");
    }).toPass({ timeout: 15_000 });
    const names = await slotSpots(overlay, "itemName");
    for (const [index, spot] of names.entries()) {
      expect(Math.abs(legacyNames[index].left - spot.left - 4)).toBeLessThan(0.5);
      expect(Math.abs(legacyNames[index].top - spot.top - 9)).toBeLessThan(0.5);
    }

    const rows = await cardGeometry(overlay, "itemName");
    await name.click();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await fields()).itemName?.x).toBe(1);
    await expect(async () => {
      expectSameGeometry(await cardGeometry(overlay, "itemName"), rows, "1 px name nudge");
      for (const [index, spot] of (await slotSpots(overlay, "itemName")).entries()) {
        expect(Math.abs(spot.left - names[index].left - 1), `name x on ${spot.slot}`).toBeLessThan(
          0.5,
        );
        expect(Math.abs(spot.top - names[index].top), `name y on ${spot.slot}`).toBeLessThan(0.5);
      }
    }).toPass({ timeout: 15_000 });
    await page
      .locator("[data-reward-editor-canvas]")
      .screenshot({ path: test.info().outputPath("editor-name-nudged.png") });
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test.describe("editor tools on one app", () => {
  let harness: ElectronTestHarness | undefined;
  let errors: string[] = [];
  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-reward-tools-shared-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
  });
  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function openEditor(variant: string): Promise<{
    page: Page;
    overlay: Frame;
    fields: () => Promise<OverlayEditState["layout"]["fields"]>;
  }> {
    errors = [];
    const page = harness!.page;
    const overlay = await openOverlayEditor(page, "reward");
    await page.locator("[data-reward-editor-preview]").selectOption(variant);
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(4);
    return { page, overlay, fields: async () => (await readState(overlay)).layout.fields };
  }

  async function cancelEditor(page: Page): Promise<void> {
    await closeEditor(page, "cancel");
    expect(errors).toEqual([]);
  }

  test("moving the chip that ends a card keeps the card height and the chip's row", async () => {
    const { page, overlay, fields } = await openEditor("missing");
    const chip = overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="owned"]');
    const gap = await chip.evaluate((element) => {
      const card = element.closest<HTMLElement>(".reward-slot")!;
      const inner =
        card.getBoundingClientRect().bottom -
        card.clientTop -
        Number.parseFloat(getComputedStyle(card).paddingBottom);
      return inner - element.getBoundingClientRect().bottom;
    });
    expect(Math.abs(gap), "the chip sets the card's bottom").toBeLessThan(1);
    const heights = () =>
      overlay
        .locator(".reward-slot")
        .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
    const before = await heights();
    const spots = await slotSpots(overlay, "owned");
    await dragField(page, chip, 40, 0, { modifier: "Control" });
    await expect.poll(async () => (await fields()).owned?.x).toBe(40);
    expect((await fields()).owned?.y, "a sideways move keeps the row").toBe(0);
    const after = await heights();
    for (const [index, height] of after.entries())
      expect(Math.abs(height - before[index]), `card ${index} height`).toBeLessThan(0.5);
    for (const [index, spot] of (await slotSpots(overlay, "owned")).entries()) {
      expect(Math.abs(spot.top - spots[index].top), `chip y on ${spot.slot}`).toBeLessThan(0.5);
      expect(Math.abs(spot.left - spots[index].left - 40), `chip x on ${spot.slot}`).toBeLessThan(
        0.5,
      );
    }
    await page
      .locator("[data-reward-editor-canvas]")
      .screenshot({ path: test.info().outputPath("editor-last-chip-moved.png") });
    await cancelEditor(page);
  });

  test("a moved part count keeps its gap below each card's own chip rows", async () => {
    const { page, overlay, fields } = await openEditor("mixed");
    const counts = () =>
      overlay.locator(".reward-slot").evaluateAll((cards) =>
        (cards as HTMLElement[]).flatMap((card) => {
          const count = card.querySelector('[data-reward-field="part0Count"]');
          if (!count?.getClientRects().length) return [];
          const box = count.getBoundingClientRect();
          const chips = Array.from(card.querySelectorAll(".slot-meta-chip"))
            .filter((chip) => chip.getClientRects().length)
            .map((chip) => chip.getBoundingClientRect());
          return [
            {
              slot: Number(card.dataset.slot),
              top: box.top - card.getBoundingClientRect().top,
              gap: box.top - Math.max(...chips.map((chip) => chip.bottom)),
              covered: chips.filter(
                (chip) =>
                  chip.top < box.bottom &&
                  chip.bottom > box.top &&
                  chip.left < box.right &&
                  chip.right > box.left,
              ).length,
            },
          ];
        }),
      );
    const before = await counts();
    expect(before.map((spot) => spot.slot)).toEqual([0, 2, 3]);
    const tops = before.map((spot) => spot.top);
    expect(Math.max(...tops) - Math.min(...tops), "a card wraps its chips").toBeGreaterThan(8);
    await overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="part0Count"]').click();
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => (await fields()).part0Count?.y).toBe(10);
    await expect(async () => {
      const after = await counts();
      expect(after.map((spot) => spot.slot)).toEqual([0, 2, 3]);
      for (const [index, spot] of after.entries()) {
        expect(Math.abs(spot.gap - after[0].gap), `gap on ${spot.slot}`).toBeLessThan(1);
        expect(Math.abs(spot.gap - before[index].gap - 10), `move on ${spot.slot}`).toBeLessThan(
          0.5,
        );
        expect(spot.covered, `chips under the count on ${spot.slot}`).toBe(0);
      }
    }).toPass({ timeout: 15_000 });
    await page
      .locator("[data-reward-editor-canvas]")
      .screenshot({ path: test.info().outputPath("editor-part-count-moved.png") });
    await cancelEditor(page);
  });

  test("align and nudge still act after the preview drops the selected card", async () => {
    const { page, overlay, fields } = await openEditor("rewards");
    await overlay.locator('.reward-slot[data-slot="3"] [data-reward-field="owned"]').click();
    await expect.poll(async () => (await readState(overlay)).selectedCard).toBe(3);
    await page.locator("[data-reward-editor-count]").selectOption("2");
    await expect(overlay.locator(".reward-slot.has-item")).toHaveCount(2);
    await page.locator('[data-reward-editor-align="right"]').click();
    await expect.poll(async () => (await fields()).owned?.x ?? 0).toBeGreaterThan(20);
    const edge = () =>
      overlay
        .locator('.reward-slot[data-slot="0"] [data-reward-field="owned"]')
        .evaluate((element) => {
          const card = element.closest<HTMLElement>(".reward-slot")!;
          const right =
            card.getBoundingClientRect().left +
            card.clientLeft +
            card.clientWidth -
            Number.parseFloat(getComputedStyle(card).paddingRight);
          return Math.abs(right - element.getBoundingClientRect().right);
        });
    await expect.poll(edge, "the chip sits on the right content edge").toBeLessThan(0.5);
    expectOneSpot(await slotSpots(overlay, "owned"), "right-aligned chip", 2);
    await page
      .locator("[data-reward-editor-canvas]")
      .screenshot({ path: test.info().outputPath("editor-align-after-count.png") });
    const aligned = (await fields()).owned!.x;
    await overlay.locator('.reward-slot[data-slot="1"]').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await fields()).owned?.x).toBe(aligned - 1);
    await cancelEditor(page);
  });

  test("a nudge after a list pick reaches a field the selected card does not show", async () => {
    const { page, overlay, fields } = await openEditor("rewards");
    await overlay.locator('.reward-slot[data-slot="1"] [data-reward-field="owned"]').click();
    await expect.poll(async () => (await readState(overlay)).selectedCard).toBe(1);
    await expect(
      overlay.locator('.reward-slot[data-slot="1"] [data-reward-field="platinumValue"]'),
    ).toHaveCount(0);
    await page.locator("[data-reward-editor-elements] summary").click();
    await page.locator('[data-reward-editor-field="platinumValue"]').click();
    await expect.poll(async () => (await readState(overlay)).selectedField).toBe("platinumValue");
    await overlay.locator('.reward-slot[data-slot="1"]').click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await fields()).platinumValue?.x).toBe(1);
    await expect(
      overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="platinumValue"]'),
    ).toHaveClass(/reward-field-selected/);
    await cancelEditor(page);
  });

  test("a group drag on a card that lacks one selected field moves it too", async () => {
    const { page, overlay, fields } = await openEditor("rewards");
    await overlay
      .locator('.reward-slot[data-slot="0"] [data-reward-field="platinumValue"]')
      .click();
    const owned = overlay.locator('.reward-slot[data-slot="1"] [data-reward-field="owned"]');
    await owned.click({ modifiers: ["Shift"] });
    await expect
      .poll(async () => (await readState(overlay)).selectedFields)
      .toEqual(["platinumValue", "owned"]);
    const price = await slotSpot(overlay, "platinumValue", 0);
    const chip = await slotSpot(overlay, "owned", 1);
    await dragField(page, owned, 0, 12, { modifier: "Control" });
    await expect
      .poll(async () => Math.abs((await slotSpot(overlay, "owned", 1)).top - chip.top - 12))
      .toBeLessThan(0.5);
    await expect
      .poll(async () => (await fields()).platinumValue?.y ?? 0, "the price moves with the chip")
      .toBe(12);
    await expect
      .poll(async () =>
        Math.abs((await slotSpot(overlay, "platinumValue", 0)).top - price.top - 12),
      )
      .toBeLessThan(0.5);
    await cancelEditor(page);
  });

  test("This card applies a typed offset to the first card that shows the field", async () => {
    const { page, overlay, fields } = await openEditor("rewards");
    expect((await readState(overlay)).selectedCard).toBeUndefined();
    await page.locator('[data-reward-editor-scope="card"]').click();
    const x = page.locator('[data-reward-editor-position="x"]');
    await x.fill("7");
    await x.dispatchEvent("change");
    await expect
      .poll(async () => (await fields()).platinumValue?.cards)
      .toEqual({
        "0": { x: 7, y: 0 },
      });
    expect((await readState(overlay)).selectedCard).toBe(0);
    await expect(x).toHaveValue("7");
    await expect(
      overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="platinumValue"]'),
    ).toHaveClass(/reward-field-selected/);
    await cancelEditor(page);
  });

  test("Ctrl+Z undoes after the slider, colour and checkbox; text inputs keep native undo", async () => {
    const { page, overlay, fields } = await openEditor("rewards");
    await overlay.locator('.reward-slot[data-slot="0"] [data-reward-field="itemName"]').click();
    const scale = page.locator("[data-reward-editor-scale]");
    await scale.focus();
    await inputValue(scale, "1.5");
    await scale.dispatchEvent("change");
    await expect.poll(async () => (await fields()).itemName?.scale).toBe(1.5);
    await expect(scale).toBeFocused();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await fields()).itemName?.scale ?? 1, "slider undo").toBe(1);

    const colour = page.locator("[data-reward-editor-color]");
    await colour.focus();
    await inputValue(colour, "#ff0000");
    await colour.dispatchEvent("change");
    await expect.poll(async () => (await fields()).itemName?.color).toBe("#ff0000");
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await fields()).itemName?.color ?? null, "colour undo")
      .toBe(null);

    const hidden = page.locator("[data-reward-editor-hidden]");
    await hidden.check();
    await expect.poll(async () => (await fields()).itemName?.hidden).toBe(true);
    await expect(hidden).toBeFocused();
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await fields()).itemName?.hidden ?? false, "hidden undo")
      .toBe(false);

    await hidden.check();
    await expect.poll(async () => (await fields()).itemName?.hidden).toBe(true);
    const depth = (await readState(overlay)).undoDepth ?? 0;
    await page.locator('[data-reward-editor-position="x"]').focus();
    await page.keyboard.press("Control+z");
    await colour.focus();
    await inputValue(colour, "#0000ff");
    await colour.dispatchEvent("change");
    await expect.poll(async () => (await fields()).itemName?.color).toBe("#0000ff");
    expect((await readState(overlay)).undoDepth, "a number input keeps its own undo").toBe(
      depth + 1,
    );
    await cancelEditor(page);
  });

  test("arrow keys nudge after a list pick and an align click but not in a number input", async () => {
    const { page, fields, overlay } = await openEditor("rewards");
    await page.locator("[data-reward-editor-elements] summary").click();
    const pick = page.locator('[data-reward-editor-field="itemName"]');
    await pick.click();
    await expect.poll(async () => (await readState(overlay)).selectedField).toBe("itemName");
    await expect(pick).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await fields()).itemName?.x, "nudge after a list pick").toBe(1);

    await page.locator('[data-reward-editor-align="left"]').click();
    await expect.poll(async () => (await fields()).itemName?.x).toBe(0);
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await fields()).itemName?.y, "nudge after align").toBe(1);

    await page.locator('[data-reward-editor-position="x"]').focus();
    await page.keyboard.press("ArrowLeft");
    await pick.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await fields()).itemName?.y).toBe(2);
    expect((await fields()).itemName?.x, "an arrow in a number input moves its caret").toBe(0);

    const scale = page.locator("[data-reward-editor-scale]");
    const before = await scale.inputValue();
    await scale.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => scale.inputValue(), "an arrow on the slider moves the slider")
      .not.toBe(before);
    expect((await fields()).itemName?.x, "an arrow on the slider leaves the field").toBe(0);
    expect((await fields()).itemName?.y).toBe(2);
    await cancelEditor(page);
  });
});

const OPACITY_THEME_ID = "custom:e2e-opacity";

function opacityTheme(activePreset: string): ThemeSettings {
  const effects = {
    ...DEFAULT_THEME.effects,
    overlayOpacity: 0.9,
    overlayOpacityOverrides: { reward: 0.6 },
  };
  return {
    ...DEFAULT_THEME,
    activePreset,
    effects,
    customThemes:
      activePreset === OPACITY_THEME_ID
        ? [
            {
              id: OPACITY_THEME_ID,
              label: "E2E",
              colors: { ...DEFAULT_THEME.colors },
              fontSizes: { ...DEFAULT_THEME.fontSizes },
              effects,
            },
          ]
        : [],
  };
}

async function openOverlayEditor(page: Page, kind: OverlayLayoutKind): Promise<Frame> {
  await page.locator('#sidebar [data-view="settings"]').click();
  await page.locator('[data-tour-tab="appearance"]').click();
  await page.locator('[data-appearance-tab="overlays"]').click();
  await page.locator(`[data-overlay-editor-open="${kind}"]`).click();
  return editorFrame(page);
}

async function closeEditor(page: Page, button: "cancel" | "save"): Promise<void> {
  await page.locator(`[data-reward-editor-${button}]`).click();
  await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
}

function previewOpacity(frame: Frame): Promise<string> {
  return frame.evaluate(() =>
    document.documentElement.style.getPropertyValue("--overlay-opacity-current"),
  );
}

function liveOpacity(page: Page, kind: OverlayLayoutKind): Promise<string | undefined> {
  return page.evaluate(
    async (overlayKind) =>
      (await window.api.getOverlayPreview(overlayKind)).theme[`--overlay-opacity-${overlayKind}`],
    kind,
  );
}

function storedTheme(page: Page): Promise<ThemeSettings> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("wf_theme_settings") || "{}"));
}

function editorOpacity(page: Page): { slider: Locator; useDefault: Locator } {
  const control = page.locator("[data-reward-editor-opacity]");
  return { slider: control.locator('input[type="range"]'), useDefault: control.locator("button") };
}

test("editor opacity Cancel and Escape keep the preset and the saved override", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-editor-opacity-cancel-", {
      storage: { wf_theme_settings: JSON.stringify(opacityTheme("default")) },
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    const { page } = harness;
    const { slider, useDefault } = editorOpacity(page);

    let overlay = await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await dragRange(slider, 40);
    await expect.poll(() => previewOpacity(overlay)).toBe("40%");
    await releaseRange(slider);
    await expect(slider).toHaveValue("40");
    await overlay.locator('[data-reward-field="platinumValue"]').first().click();
    await expect(page.locator('[data-reward-editor-field="platinumValue"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator("[data-reward-editor-preview]").selectOption("rewards");
    await expect.poll(async () => (await readState(overlay)).previewVariant).toBe("rewards");
    await expect(slider).toHaveValue("40");
    expect(await previewOpacity(overlay)).toBe("40%");
    expect(await liveOpacity(page, "reward")).toBe("60%");
    await closeEditor(page, "cancel");
    expect(await liveOpacity(page, "reward")).toBe("60%");

    overlay = await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await expect.poll(() => previewOpacity(overlay)).toBe("60%");
    await page
      .locator("[data-reward-editor]")
      .screenshot({ path: test.info().outputPath("editor-opacity-after-cancel.png") });
    await dragRange(slider, 45);
    await releaseRange(slider);
    await expect.poll(() => previewOpacity(overlay)).toBe("45%");
    await slider.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-reward-editor]")).toHaveCount(0);

    overlay = await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await expect(useDefault).toBeEnabled();
    await useDefault.click();
    await expect(slider).toHaveValue("90");
    await expect(useDefault).toBeDisabled();
    await expect.poll(() => previewOpacity(overlay)).toBe("90%");
    await closeEditor(page, "cancel");

    await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await expect(useDefault).toBeEnabled();
    await closeEditor(page, "cancel");
    expect(await liveOpacity(page, "reward")).toBe("60%");

    harness = await restartElectronTestHarness(harness);
    const theme = await storedTheme(harness.page);
    expect(theme.activePreset).toBe("default");
    expect(theme.effects.overlayOpacity).toBe(0.9);
    expect(theme.effects.overlayOpacityOverrides).toEqual({ reward: 0.6 });
    expect(theme.customThemes).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("editor opacity Save updates the active custom theme and survives a restart", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  const customOverrides = (theme: ThemeSettings) =>
    theme.customThemes.map((entry) => [entry.id, entry.effects.overlayOpacityOverrides]);
  try {
    harness = await launchElectronTestHarness("wfh-editor-opacity-save-", {
      storage: { wf_theme_settings: JSON.stringify(opacityTheme(OPACITY_THEME_ID)) },
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    let { page } = harness;
    let { slider, useDefault } = editorOpacity(page);

    await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await useDefault.click();
    await expect(slider).toHaveValue("90");
    await closeEditor(page, "cancel");

    let overlay = await openOverlayEditor(page, "planner");
    await expect(slider).toHaveValue("90");
    await expect(useDefault).toBeDisabled();
    await dragRange(slider, 70);
    await releaseRange(slider);
    await expect(slider).toHaveValue("70");
    await expect(useDefault).toBeEnabled();
    await expect.poll(() => previewOpacity(overlay)).toBe("70%");
    expect(await liveOpacity(page, "planner")).toBe("90%");
    await closeEditor(page, "save");
    const saved = { reward: 0.6, planner: 0.7 };
    await expect
      .poll(async () => (await storedTheme(page)).effects.overlayOpacityOverrides)
      .toEqual(saved);
    let theme = await storedTheme(page);
    expect(theme.activePreset).toBe(OPACITY_THEME_ID);
    expect(theme.effects.overlayOpacity).toBe(0.9);
    expect(customOverrides(theme)).toEqual([[OPACITY_THEME_ID, saved]]);
    await expect.poll(() => liveOpacity(page, "planner")).toBe("70%");
    expect(await liveOpacity(page, "reward")).toBe("60%");

    harness = await restartElectronTestHarness(harness);
    ({ page } = harness);
    ({ slider, useDefault } = editorOpacity(page));
    await openOverlayEditor(page, "planner");
    await expect(slider).toHaveValue("70");
    await closeEditor(page, "cancel");

    overlay = await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("60");
    await useDefault.click();
    await expect(slider).toHaveValue("90");
    await expect.poll(() => previewOpacity(overlay)).toBe("90%");
    await closeEditor(page, "save");
    await expect
      .poll(async () => (await storedTheme(page)).effects.overlayOpacityOverrides)
      .toEqual({ planner: 0.7 });
    theme = await storedTheme(page);
    expect(theme.activePreset).toBe(OPACITY_THEME_ID);
    expect(customOverrides(theme)).toEqual([[OPACITY_THEME_ID, { planner: 0.7 }]]);
    await expect.poll(() => liveOpacity(page, "reward")).toBe("90%");

    await openOverlayEditor(page, "reward");
    await expect(slider).toHaveValue("90");
    await expect(useDefault).toBeDisabled();
  } finally {
    await closeElectronTestHarness(harness);
  }
});
