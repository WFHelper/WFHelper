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
} from "../config/shared/overlayLayout";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
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
  await page.locator('[data-tour-tab="customization"]').click();
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
    for (const label of await overlay.locator('[data-reward-field="platinumValue"]').all()) {
      const offset = await label.evaluate((element) =>
        getComputedStyle(element).translate.split(" ").map(Number.parseFloat),
      );
      expect(offset[0]).toBeCloseTo(moved!.x, 2);
      expect(offset[1]).toBeCloseTo(moved!.y, 2);
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

    await page.locator('[data-tour-tab="general"]').click();
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
    await page.mouse.move(labelBox.x + 3, labelBox.y + 3);
    await page.mouse.down();
    await expect(overlay.locator("body")).toHaveAttribute("data-edit-held", "true");
    await page.mouse.move(
      labelBox.x + 3 + (30 * previewBox.width) / REWARD_OVERLAY_CANVAS.width,
      labelBox.y + 3,
    );
    await page.mouse.up();
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
    await page.mouse.move(priceBox.x + 3, priceBox.y + 3);
    await page.mouse.down();
    await page.mouse.move(
      priceBox.x + 3 + (20 * secondPreviewBox.width) / REWARD_OVERLAY_CANVAS.width,
      priceBox.y + 3,
    );
    await page.mouse.up();
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
