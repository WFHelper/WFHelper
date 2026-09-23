import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { getOverlayDescriptor, OVERLAY_LAYOUT_KINDS } from "../config/shared/overlayLayout";
import { SYSTEM_CONFIRM } from "../config/shared/ipcChannels";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

test("customization export and import restores renderer and all overlay layouts after reload", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  const errors: string[] = [];
  try {
    harness = await launchElectronTestHarness("wfh-customization-transfer-", {
      storage: { wf_sidebar_width: "230", wf_inventory_view_mode: "list" },
      userDataFiles: {
        "overlay-settings.json": {
          overlayScale: 1.2,
          hotkey: "F10",
          notificationSoundVolume: 0.37,
        },
      },
      onPage: (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
      },
    });
    const { page, app } = harness;
    await evaluateInMain(
      app,
      ({ ipcMain }, channel) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => true);
      },
      SYSTEM_CONFIRM,
    );
    await openView(page, "settings");
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="sidebar"]').click();
    await page.locator("[data-customization-css]").check();
    const downloadedPath = path.join(harness.sandboxDir, "customization-export.json");
    await evaluateInMain(
      app,
      ({ BrowserWindow }, destination) => {
        BrowserWindow.getAllWindows()[0]!.webContents.session.once(
          "will-download",
          (_event, item) => {
            item.setSavePath(destination);
          },
        );
      },
      downloadedPath,
    );
    await page.locator("[data-customization-export]").click();
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(downloadedPath, "utf8")).kind;
        } catch {
          return null;
        }
      })
      .toBe("wfhelper-customization");
    const original = JSON.parse(await fs.readFile(downloadedPath, "utf8"));
    expect(original.kind).toBe("wfhelper-customization");
    expect(Object.keys(original.overlays.overlayLayouts)).toHaveLength(6);
    expect(original.overlays.hotkey).toBeUndefined();
    const edited = structuredClone(original);
    edited.theme.colors.accent = "#123456";
    edited.workspace.sidebar.width = 260;
    edited.workspace.sidebar.hidden = ["mastery"];
    edited.inventoryViewMode = "cards";
    edited.customCss = ".card { color: red; }";
    edited.overlays.uiScale = 1.1;
    edited.overlays.overlayWindowScales.reward = 1.3;
    const fields = Object.fromEntries(
      OVERLAY_LAYOUT_KINDS.map((kind) => [kind, getOverlayDescriptor(kind).fields[0]!]),
    );
    for (const [kind, field] of Object.entries(fields))
      edited.overlays.overlayLayouts[kind].fields[field] = {
        x: 4,
        y: 5,
        scale: 1.3,
        hidden: true,
        color: "#123456",
      };
    edited.overlays.rewardLayout = structuredClone(edited.overlays.overlayLayouts.reward);
    await page.locator("[data-customization-file]").setInputFiles({
      name: "customization.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(edited)),
    });
    await expect(page.locator("[data-customization-status]")).toBeVisible();
    await expect(
      page.locator('[data-tab-rename="mastery"]').locator("..").locator('input[type="checkbox"]'),
    ).not.toBeChecked();
    await expect(page.locator('#sidebar [data-view="mastery"]')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_sidebar_width")))
      .toBe("260");
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("wf_theme_settings") ?? "{}").colors?.accent,
        ),
      )
      .toBe("#123456");
    await page.locator('[data-tour-tab="overlay"]').click();
    await expect(page.locator('input[type="range"][min="0.75"]').first()).toHaveValue("1.3");
    await page.locator('[data-setting="rivenOverlay"] input').uncheck();
    await expect
      .poll(() => page.evaluate(() => window.api.getOverlaySettings()))
      .toMatchObject({ uiScale: 1.1, rivenOverlayEnabled: false });
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem("wf_inventory_view_mode"))).toBe("cards");
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("wf_custom_css_v1") ?? "{}").enabled,
      ),
    ).toBe(false);
    const disk = JSON.parse(
      await fs.readFile(
        path.join(harness.sandboxDir, "user-data", "overlay-settings.json"),
        "utf8",
      ),
    );
    expect(disk.hotkey).toBe("F10");
    expect(disk.notificationSoundVolume).toBe(0.37);
    expect(disk.uiScale).toBe(1.1);
    expect(disk.overlayWindowScales.reward).toBe(1.3);
    for (const [kind, field] of Object.entries(fields)) {
      const layout = kind === "reward" ? disk.rewardLayout : disk.overlayLayouts[kind];
      expect(layout.fields[field].hidden).toBe(true);
    }
    await openView(page, "settings");
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="sidebar"]').click();
    await page.locator("[data-customization-css]").check();
    await page.locator("[data-customization-file]").setInputFiles({
      name: "restore.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(original)),
    });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_sidebar_width")))
      .toBe("230");
    await page.locator('[data-appearance-tab="css"]').click();
    await expect(page.locator("[data-custom-css-editor]")).toHaveValue(original.customCss);
    await page.screenshot({
      path: test.info().outputPath("customization-transfer.png"),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    if (harness) await closeElectronTestHarness(harness);
  }
});
