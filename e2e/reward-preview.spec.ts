import { test, expect } from "@playwright/test";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

test("last reward preview preserves completed prices and slot gaps at the live logical width", async () => {
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-reward-preview-");
    const { page } = harness;
    const before = await page.evaluate(() => window.api.getOverlayPreview("reward"));
    expect(before.lastReward).toBeNull();
    expect(before.descriptor.variants.some((variant) => variant.value === "last")).toBe(false);
    await evaluateInMain(harness.app, async ({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const client = load("./services/wfmClient.js") as typeof import("../services/wfmClient");
      const stats = load(
        "./services/wfmStatsPrice.js",
      ) as typeof import("../services/wfmStatsPrice");
      const original = client.request;
      client.request = async (method, endpoint, ...args) => {
        if (method === "GET" && endpoint === "/items/preview_fixture/statistics") {
          return {
            payload: {
              statistics_closed: {
                "48hours": [{ datetime: new Date().toISOString(), wa_price: 245, volume: 10 }],
              },
            },
          };
        }
        return original(method, endpoint, ...args);
      };
      try {
        if ((await stats.fetchPriceBySlug("preview_fixture")) !== 245)
          throw new Error("Price fixture did not load");
      } finally {
        client.request = original;
      }
      const controller = (
        load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc")
      ).rewardWindowsController;
      controller.createOverlayWindow();
      controller.sendOverlayEvent("relic-reward-items", [
        {
          slotIndex: 0,
          name: "Sevagoth Prime Neuroptics Blueprint",
          urlName: "preview_fixture",
          rarity: "rare",
          ducats: 100,
          mastered: false,
          building: true,
          partOwnedCount: 20,
          partRequiredCount: 2,
          setParts: [
            {
              name: "Neuroptics",
              ownedCount: 20,
              requiredCount: 2,
              isReward: true,
              building: true,
            },
          ],
        },
        { slotIndex: 3, name: "Forma Blueprint", rarity: "common", ducats: 0 },
      ]);
    });
    const live = await overlayWindow(harness, "overlay.html", "mode=planner");
    await expect(live.locator('.reward-slot[data-slot="0"] .slot-plat-value')).toContainText("245");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.api.getOverlayPreview("reward"))).lastReward?.count,
      )
      .toBe(2);
    await evaluateInMain(harness.app, ({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const ctx = (load("./ipc/context.js") as typeof import("../ipc/context")).default;
      ctx.overlayWindow!.setSize(1000, 400);
      ctx.overlayWindow!.webContents.setZoomFactor(1.25);
    });
    const preview = await page.evaluate(() => window.api.getOverlayPreview("reward"));
    expect(preview.canvas.width).toBe(800);
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="overlays"]').click();
    await page.locator('[data-overlay-editor-open="reward"]').click();
    const frameElement = page.locator("[data-reward-editor-frame]");
    await expect(frameElement).toBeVisible();
    const frame = await (await frameElement.elementHandle())?.contentFrame();
    if (!frame) throw new Error("Reward preview did not mount");
    await expect(frame.locator("body")).toHaveClass(/reward-layout-editing/);
    await page.locator("[data-reward-editor-preview]").selectOption("last");
    await expect(page.locator("[data-reward-editor-count]")).toBeDisabled();
    await expect(page.locator("[data-reward-editor-count]")).toHaveValue("2");
    await expect(frame.locator(".reward-slot.has-item")).toHaveCount(2);
    await expect(frame.locator('.reward-slot[data-slot="0"] .slot-name')).toHaveText(
      "Sevagoth Prime Neuroptics Blueprint",
    );
    await expect(frame.locator('.reward-slot[data-slot="3"] .slot-name')).toHaveText(
      "Forma Blueprint",
    );
    await expect(frame.locator('.reward-slot[data-slot="1"]')).toHaveClass(/empty-slot/);
    await expect(frame.locator('.reward-slot[data-slot="0"] .slot-plat-value')).toContainText(
      "245",
    );
    await expect(frame.locator('.reward-slot[data-slot="0"] .slot-set-part')).toHaveClass(
      /is-reward/,
    );
    expect(await frame.evaluate(() => window.innerWidth)).toBe(800);
    await frame.locator('[data-reward-field="platinumValue"]').first().click();
    await page.locator('[data-reward-editor-position="x"]').fill("0");
    await page.locator('[data-reward-editor-position="x"]').dispatchEvent("change");
    await frame.locator('[data-reward-field="platinumValue"]').first().click();
    await expect.poll(() => frame.evaluate(() => document.hasFocus())).toBe(true);
    await expect(page.locator('[data-reward-editor-position="x"]')).not.toBeFocused();
    await frame.locator("body").press("ArrowRight");
    await expect(page.locator('[data-reward-editor-position="x"]')).toHaveValue("1");
    await frame.locator("body").press("Shift+ArrowRight");
    await expect(page.locator('[data-reward-editor-position="x"]')).toHaveValue("11");
    await evaluateInMain(harness.app, ({ app }) => {
      const load = process
        .getBuiltinModule("module")
        .createRequire(`${app.getAppPath()}/.electron-build/main.js`);
      const controller = (
        load("./ipc/rewardOverlayIpc.js") as typeof import("../ipc/rewardOverlayIpc")
      ).rewardWindowsController;
      controller.sendOverlayEvent("relic-reward-items", [
        { name: "Replacement screen", rarity: "common", ducats: 0 },
      ]);
    });
    await expect(live.locator('.reward-slot[data-slot="0"] .slot-name')).toHaveText(
      "Replacement screen",
    );
    await page.locator("[data-reward-editor-preview]").selectOption("mixed");
    await page.locator("[data-reward-editor-preview]").selectOption("last");
    await expect(frame.locator('.reward-slot[data-slot="0"] .slot-name')).toHaveText(
      "Sevagoth Prime Neuroptics Blueprint",
    );
    await expect(frame.locator('.reward-slot[data-slot="0"] .slot-plat-value')).toContainText(
      "245",
    );
    await page
      .locator("[data-reward-editor]")
      .screenshot({ path: test.info().outputPath("last-reward-preview.png") });
    await page.locator("[data-reward-editor-cancel]").click();
  } finally {
    await closeElectronTestHarness(harness);
  }
});
