import { test, expect as baseExpect, type Frame, type Page } from "@playwright/test";

import type { OverlayLayoutKind } from "../config/shared/overlayLayout";
import { DEFAULT_THEME } from "../src/config/themeDefaults";
import {
  closeElectronTestHarness,
  dragRange,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  releaseRange,
  type ElectronTestHarness,
} from "./electronTestHarness";

const expect = baseExpect.configure({ timeout: 15_000 });
const SURFACES = [
  {
    kind: "reward",
    selectors: ["#panel"],
    tokens: ["--bg-surface"],
    alpha: [1],
    blur: "blur(8px)",
  },
  {
    kind: "planner",
    selectors: ["#panel", ".plan-card:not(.best)"],
    tokens: ["--bg-surface", "--bg-surface"],
    alpha: [1, 0.94 * 0.94],
    blur: "blur(8px)",
  },
  {
    kind: "rivenLeft",
    selectors: ["#panel", "#roll-badge"],
    tokens: ["--bg-deep", "--bg-raised"],
    alpha: [1, 1],
    blur: "none",
  },
  {
    kind: "rivenRight",
    selectors: ["#panel", "#roll-badge"],
    tokens: ["--bg-deep", "--bg-raised"],
    alpha: [1, 1],
    blur: "none",
  },
  {
    kind: "arbiSummary",
    selectors: ["#panel", "#header", ".kpi", "#footer"],
    tokens: ["--bg-deep", "--bg-surface", "--bg-deep", "--bg-surface"],
    alpha: [1, 1, 1, 1],
    blur: "none",
  },
  {
    kind: "tradeNotification",
    selectors: ["#notification"],
    tokens: ["--bg-surface"],
    alpha: [0.92],
    blur: "blur(12px)",
  },
] satisfies Array<{
  kind: OverlayLayoutKind;
  selectors: string[];
  tokens: string[];
  alpha: number[];
  blur: string;
}>;

async function openAppearance(page: Page): Promise<void> {
  await page.locator('#sidebar [data-view="settings"]').click();
  await page.locator('[data-tour-tab="appearance"]').click();
  await page.locator('[data-appearance-tab="overlays"]').click();
}

async function setOpacity(page: Page, percent: number): Promise<void> {
  await openAppearance(page);
  const slider = page.locator('[data-overlay-opacity-control] input[type="range"]');
  await dragRange(slider, percent);
  await releaseRange(slider);
  await expect(slider).toHaveValue(String(percent));
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.api.getOverlayPreview("reward")).theme["--overlay-opacity"],
      ),
    )
    .toBe(`${percent}%`);
}

async function openPreview(page: Page, kind: OverlayLayoutKind): Promise<Frame> {
  await page.locator('[data-tour-tab="appearance"]').click();
  await page.locator('[data-appearance-tab="overlays"]').click();
  await page.locator(`[data-overlay-editor-open="${kind}"]`).click();
  const iframe = await page.locator("[data-reward-editor-frame]").elementHandle();
  const frame = await iframe?.contentFrame();
  if (!frame) throw new Error(`${kind} preview did not mount`);
  await expect(frame.locator("body")).toHaveClass(/reward-layout-editing/);
  if (kind === "planner") {
    await page.locator("[data-reward-editor-count]").selectOption("4");
    await expect(frame.locator(".plan-card:not(.best)").first()).toBeVisible();
  }
  return frame;
}

async function openOpacityOverrides(page: Page): Promise<void> {
  await openAppearance(page);
  const overrides = page.locator("[data-overlay-opacity-overrides]");
  if ((await overrides.getAttribute("open")) === null) await overrides.locator("summary").click();
}

async function paintedColors(frame: Frame, selectors: string[], tokens: string[]) {
  return frame.evaluate(
    ({ selectors, tokens }) => {
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("Canvas color conversion unavailable");
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      return selectors.map((selector, index) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing painted surface ${selector}`);
        const style = getComputedStyle(element);
        return {
          actual: rgba(style.backgroundColor),
          source: rgba(style.getPropertyValue(tokens[index]).trim()),
          blur: style.backdropFilter,
        };
      });
    },
    { selectors, tokens },
  );
}

test("opacity slider persists and every preview preserves its surface colors and blur", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-overlay-opacity-ui-", {
      storage: { wf_theme_settings: JSON.stringify(DEFAULT_THEME) },
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    const { page } = harness;
    for (const percent of [100, 50]) {
      await setOpacity(page, percent);
      for (const surface of SURFACES) {
        const preview = await openPreview(page, surface.kind);
        await expect
          .poll(() =>
            preview.evaluate(() =>
              getComputedStyle(document.documentElement)
                .getPropertyValue("--overlay-opacity")
                .trim(),
            ),
          )
          .toBe(`${percent}%`);
        const colors = await paintedColors(preview, surface.selectors, surface.tokens);
        colors.forEach(({ actual, source }, index) => {
          for (let channel = 0; channel < 3; channel++)
            expect(Math.abs(actual[channel] - source[channel])).toBeLessThanOrEqual(3);
          expect(
            Math.abs(actual[3] - (source[3] * surface.alpha[index] * percent) / 100),
          ).toBeLessThanOrEqual(2);
        });
        expect(colors[0].blur).toBe(surface.blur);
        if (surface.kind === "arbiSummary") {
          const foreground = await preview.locator("#btn-details").evaluate((element) => {
            const style = getComputedStyle(element);
            const context = document.createElement("canvas").getContext("2d")!;
            context.fillStyle = style.color;
            context.fillRect(0, 0, 1, 1);
            return context.getImageData(0, 0, 1, 1).data[3];
          });
          expect(foreground).toBe(255);
        }
        await page
          .locator("[data-reward-editor-frame]")
          .screenshot({ path: test.info().outputPath(`${surface.kind}-${percent}.png`) });
        await page.locator("[data-reward-editor-cancel]").click();
        await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
      }
    }
    await setOpacity(page, 30);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("wf_theme_settings") || "{}").effects.overlayOpacity,
        ),
      )
      .toBe(0.3);
    await page.reload();
    await openAppearance(page);
    await expect(page.locator('[data-overlay-opacity-control] input[type="range"]')).toHaveValue(
      "30",
    );
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("wf_theme_settings") || "{}").effects.overlayOpacity,
      ),
    ).toBe(0.3);
    await page
      .locator('[data-appearance-panel="overlays"]')
      .screenshot({ path: test.info().outputPath("opacity-reloaded.png") });
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("overlay theme IPC accepts bounded whole percentages and rejects malformed opacity", async () => {
  test.setTimeout(120_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-overlay-opacity-ipc-", {
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    await evaluateInMain(harness.app, ({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const reward = load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc");
      reward.rewardWindowsController.createOverlayWindow();
    });
    const reward = await overlayWindow(harness, "/renderer/overlay.html", "mode=planner");
    const opacityKeys = [
      "--overlay-opacity",
      ...SURFACES.map(({ kind }) => `--overlay-opacity-${kind}`),
    ];
    for (const value of [
      "30%",
      "50%",
      "100%",
      "0%",
      "29%",
      "101%",
      "0.5",
      "50.5%",
      "var(--bg-surface)",
      "50%; color:red",
    ]) {
      const accepted = ["30%", "50%", "100%"].includes(value);
      const previewTheme = await harness.page.evaluate(
        async ({ opacity, keys }) => {
          window.api.updateOverlayTheme({
            "--bg-surface": "#112233",
            ...Object.fromEntries(keys.map((key) => [key, opacity])),
            "--overlay-opacity-unknown": "50%",
          });
          return (await window.api.getOverlayPreview("reward")).theme;
        },
        { opacity: value, keys: opacityKeys },
      );
      for (const key of opacityKeys) expect(previewTheme[key]).toBe(accepted ? value : undefined);
      expect(previewTheme["--overlay-opacity-unknown"]).toBeUndefined();
      const theme = await reward.evaluate(() =>
        (
          window as unknown as { overlay: { getThemeVars: () => Promise<Record<string, string>> } }
        ).overlay.getThemeVars(),
      );
      for (const key of opacityKeys) expect(theme[key]).toBe(accepted ? value : undefined);
      expect(theme["--bg-surface"]).toBe("#112233");
      if (accepted) {
        await expect
          .poll(() =>
            reward.locator("#panel").evaluate((element) => {
              const context = document.createElement("canvas").getContext("2d")!;
              context.fillStyle = getComputedStyle(element).backgroundColor;
              context.fillRect(0, 0, 1, 1);
              return Math.round((context.getImageData(0, 0, 1, 1).data[3] / 255) * 100);
            }),
          )
          .toBe(Number.parseInt(value));
      }
    }
    await harness.page.evaluate(() =>
      window.api.updateOverlayTheme({ "--bg-surface": "#112233", "--overlay-opacity": "80%" }),
    );
    await expect
      .poll(() =>
        reward.locator("#panel").evaluate((element) => {
          const context = document.createElement("canvas").getContext("2d")!;
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return Math.round((context.getImageData(0, 0, 1, 1).data[3] / 255) * 100);
        }),
      )
      .toBe(80);
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("each overlay keeps its own opacity and can return to the shared default", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-overlay-opacity-independent-", {
      storage: { wf_theme_settings: JSON.stringify(DEFAULT_THEME) },
      userDataFiles: { "overlay-settings.json": { notificationSoundEnabled: false } },
    });
    const { page } = harness;
    await setOpacity(page, 90);
    await openOpacityOverrides(page);
    const percentages = [30, 40, 50, 60, 70, 80];
    for (const [index, surface] of SURFACES.entries()) {
      const row = page.locator(`[data-overlay-opacity-kind="${surface.kind}"]`);
      const slider = row.locator('input[type="range"]');
      await expect(slider).toHaveValue("90");
      await dragRange(slider, percentages[index]);
      await releaseRange(slider);
      await expect(slider).toHaveValue(String(percentages[index]));
    }
    const expectedOverrides = Object.fromEntries(
      SURFACES.map((surface, index) => [surface.kind, percentages[index] / 100]),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("wf_theme_settings") || "{}").effects
              .overlayOpacityOverrides,
        ),
      )
      .toEqual(expectedOverrides);
    await page.locator("[data-overlay-opacity-overrides]").screenshot({
      path: test.info().outputPath("independent-opacity-controls.png"),
    });
    await page.reload();
    await openOpacityOverrides(page);
    for (const [index, surface] of SURFACES.entries()) {
      await expect(
        page.locator(`[data-overlay-opacity-kind="${surface.kind}"] input[type="range"]`),
      ).toHaveValue(String(percentages[index]));
    }
    for (const [index, surface] of SURFACES.entries()) {
      const preview = await openPreview(page, surface.kind);
      await expect
        .poll(async () => {
          const colors = await paintedColors(preview, surface.selectors, surface.tokens);
          return colors.every(
            ({ actual, source }, layer) =>
              Math.abs(actual[3] - (source[3] * surface.alpha[layer] * percentages[index]) / 100) <=
              2,
          );
        })
        .toBe(true);
      await page.locator("[data-reward-editor-frame]").screenshot({
        path: test.info().outputPath(`${surface.kind}-independent.png`),
      });
      await page.locator("[data-reward-editor-cancel]").click();
      await expect(page.locator("[data-reward-editor]")).toHaveCount(0);
    }
    await openOpacityOverrides(page);
    await page.locator('[data-overlay-opacity-kind="reward"] button').click();
    await expect(
      page.locator('[data-overlay-opacity-kind="reward"] input[type="range"]'),
    ).toHaveValue("90");
    await setOpacity(page, 70);
    await openOpacityOverrides(page);
    for (const [index, surface] of SURFACES.entries()) {
      await expect(
        page.locator(`[data-overlay-opacity-kind="${surface.kind}"] input[type="range"]`),
      ).toHaveValue(String(index === 0 ? 70 : percentages[index]));
    }
    const reward = await openPreview(page, "reward");
    await expect
      .poll(async () => {
        const [color] = await paintedColors(reward, ["#panel"], ["--bg-surface"]);
        return Math.abs(color.actual[3] - color.source[3] * 0.7);
      })
      .toBeLessThanOrEqual(2);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
