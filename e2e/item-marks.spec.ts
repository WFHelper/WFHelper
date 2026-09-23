import { expect, test, type Page } from "@playwright/test";

import { DB_GET_RELIC_DATABASE } from "../config/shared/ipcChannels";
import type { RelicDatabase } from "../src/types/relics";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const FRAME = "/Lotus/Powersuits/Mag/MagPrime";
const RELIC_KEY = "Lith M1";
const RELIC_UNIQUE = "/Lotus/Types/Game/Projections/M1_intact";

interface SeededPart {
  uniqueName: string;
  name: string;
}

/** The part uniqueName and its catalogue name come from the shipped database,
 *  so the fixture cannot drift from whatever the item DB spells today. */
async function readFramePart(page: Page): Promise<SeededPart> {
  const part = await page.evaluate(async (frame) => {
    const db = (await window.api.getItemDatabase()) as unknown as Record<
      string,
      { name?: string; components?: Array<{ uniqueName?: string }> }
    >;
    for (const component of db[frame]?.components ?? []) {
      const uniqueName = component.uniqueName;
      const name = uniqueName ? db[uniqueName]?.name : undefined;
      if (uniqueName && name) return { uniqueName, name };
    }
    return null;
  }, FRAME);

  expect(part, "the item database has no named Mag Prime component").not.toBeNull();
  return part as SeededPart;
}

function relicDatabase(rewardName: string): RelicDatabase {
  return {
    groups: {
      [RELIC_KEY]: {
        key: RELIC_KEY,
        name: RELIC_KEY,
        tier: "Lith",
        code: "M1",
        imageUrl: null,
        qualities: {
          intact: {
            uniqueName: RELIC_UNIQUE,
            rewards: [
              {
                name: rewardName,
                rarity: "common",
                chance: 25.33,
                urlName: null,
                ducats: 15,
              },
            ],
          },
        },
      },
    },
    byUniqueName: { [RELIC_UNIQUE]: { groupKey: RELIC_KEY, quality: "intact" } },
  };
}

test.describe("Mastered / crafted item marks", () => {
  test.setTimeout(240_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;
  let part: SeededPart;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-item-marks-", { inventory: { Suits: [] } });
    page = harness.page;
    part = await readFramePart(page);

    // A maxed Suits entry masters the frame and keeps it owned; the loose part
    // is the row whose parent both marks describe.
    writeHarnessInventory(harness, {
      Suits: [{ ItemType: FRAME, ItemId: { $oid: "a1" }, XP: 1_000_000 }],
      MiscItems: [{ ItemType: part.uniqueName, ItemCount: 2 }],
      LevelKeys: [{ ItemType: RELIC_UNIQUE, ItemCount: 3 }],
    });
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, payload) => {
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, () => payload.data);
      },
      { channel: DB_GET_RELIC_DATABASE, data: relicDatabase(part.name) },
    );
    await page.reload();
    await setLayoutViewport(page, 1440, 900);
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function openTab(tab: string): Promise<void> {
    await openView(page, "inventory");
    await page.locator(`[data-tour-tab="${tab}"]`).click();
  }

  test("a card carries M and C for the build its part feeds", async () => {
    await openTab("all_parts");
    const card = page.locator(`[data-inventory-card="${part.uniqueName}"]`);
    // The marks wait on the mastery pass, which lands after the inventory does.
    await expect(card.locator('[data-item-mark="mastered"]')).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-item-mark="crafted"]')).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("item-marks-cards.png"),
    });
    await card.locator(".expand-link").click();
    const detail = page.locator(".detail-panel:has([data-item-detail])");
    await expect(detail.locator('.detail-tags [data-item-mark="mastered"]')).toBeVisible();
    await expect(detail.locator('.detail-tags [data-item-mark="crafted"]')).toHaveAttribute(
      "title",
      "Parent item owned",
    );
    await detail.screenshot({ path: test.info().outputPath("item-marks-detail.png") });
    await detail.locator(".detail-close").click();
  });

  test("M and C can be hidden independently and the settings survive reload", async () => {
    const card = page.locator(`[data-inventory-card="${part.uniqueName}"]`);
    await openView(page, "settings");
    await page.locator('[data-tour-tab="inventory"]').click();
    await page.locator('[data-setting="show-mastered-badges"] input').uncheck();
    await openTab("all_parts");
    await expect(card.locator('[data-item-mark="mastered"]')).toHaveCount(0);
    await expect(card.locator('[data-item-mark="crafted"]')).toBeVisible();

    await openView(page, "settings");
    await page.locator('[data-setting="show-owned-parent-badges"] input').uncheck();
    await page.reload();
    await openView(page, "settings");
    await expect(page.locator('[data-setting="show-mastered-badges"] input')).not.toBeChecked();
    await expect(page.locator('[data-setting="show-owned-parent-badges"] input')).not.toBeChecked();
    await page.locator('[data-setting="show-mastered-badges"] input').check();
    await openTab("all_parts");
    await expect(card.locator('[data-item-mark="mastered"]')).toBeVisible();
    await expect(card.locator('[data-item-mark="crafted"]')).toHaveCount(0);
    await card.locator(".expand-link").click();
    const detail = page.locator(".detail-panel:has([data-item-detail])");
    await expect(detail.locator('.detail-tags [data-item-mark="mastered"]')).toBeVisible();
    await expect(detail.locator('.detail-tags [data-item-mark="crafted"]')).toHaveCount(0);
    await detail.locator(".detail-close").click();
    await openView(page, "settings");
    await page.locator('[data-setting="show-owned-parent-badges"] input').check();
  });

  test("the built frame carries M alone, since owning it is what the card says", async () => {
    await openTab("equipment");
    const card = page.locator(`[data-inventory-card="${FRAME}"]`);
    await expect(card.locator('[data-item-mark="mastered"]')).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-item-mark="crafted"]')).toHaveCount(0);
  });

  test("the same two marks reach the rows view", async () => {
    // The Cards/Rows switch lives in Settings; the store it writes is seeded
    // directly so this spec does not ride on that settings control's markup.
    await page.evaluate(() => localStorage.setItem("wf_inventory_view_mode", "list"));
    await page.reload();
    await setLayoutViewport(page, 1440, 900);

    await openTab("all_parts");
    const row = page.locator(`[data-list-row="${part.uniqueName}"]`);
    await expect(row.locator('[data-item-mark="mastered"]')).toBeVisible({ timeout: 60_000 });
    await expect(row.locator('[data-item-mark="crafted"]')).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("item-marks-rows.png"),
    });
  });

  test("a relic reward row marks the build the reward belongs to", async () => {
    await openView(page, "relics");
    // The planner's 32px preview icons carry the marks in their tooltip instead.
    await expect(page.locator(".relic-reward-preview-icon").first()).toHaveAttribute(
      "title",
      /Mag Prime Blueprint.*· Mastered/,
      { timeout: 30_000 },
    );

    await page.locator(".relic-compact-head").first().click();
    const rows = page.locator(".relic-rewards-list");
    await expect(rows).toBeVisible({ timeout: 30_000 });
    await expect(rows.locator('[data-item-mark="mastered"]')).toBeVisible({ timeout: 30_000 });
    await expect(rows.locator('[data-item-mark="crafted"]')).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("item-marks-relic-rewards.png"),
    });

    // The component panel behind that row names the parent, so it marks it too.
    await rows.locator("button").first().click();
    const panel = page.locator(".relic-reward-item-panel");
    await expect(panel.locator('[data-item-mark="mastered"]')).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('[data-item-mark="crafted"]')).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("item-marks-component-panel.png"),
    });
  });
});
