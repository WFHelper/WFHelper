import { expect, test, type Page } from "@playwright/test";

import { DB_GET_RELIC_DATABASE } from "../config/shared/ipcChannels";
import type { RawInventoryData } from "../src/types/inventory";
import type { RelicDatabase, RelicQuality, RelicReward } from "../src/types/relics";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Real projection keys, so the item database has a simple popup for each.
const LITH_A1: Record<RelicQuality, string> = {
  intact: "/Lotus/Types/Game/Projections/T1VoidProjectionGBronze",
  exceptional: "/Lotus/Types/Game/Projections/T1VoidProjectionGSilver",
  flawless: "/Lotus/Types/Game/Projections/T1VoidProjectionGGold",
  radiant: "/Lotus/Types/Game/Projections/T1VoidProjectionGPlatinum",
};
const NO_REWARDS = "/Lotus/Types/Game/Projections/T1VoidProjectionYBronze";
const STORAGE_KEY = "wf_relic_view";

const REWARDS: RelicReward[] = [
  { name: "Fixture Common", rarity: "Common", chance: 25.33, urlName: null, ducats: 15 },
  { name: "Fixture Rare", rarity: "Rare", chance: 2, urlName: null, ducats: 100 },
];

const relics: RelicDatabase = {
  groups: {
    "Lith A1": {
      key: "Lith A1",
      name: "Lith A1",
      tier: "Lith",
      code: "A1",
      imageUrl: null,
      qualities: {},
    },
    "Lith B1": {
      key: "Lith B1",
      name: "Lith B1",
      tier: "Lith",
      code: "B1",
      imageUrl: null,
      qualities: { intact: { uniqueName: NO_REWARDS, rewards: [] } },
    },
  },
  byUniqueName: { [NO_REWARDS]: { groupKey: "Lith B1", quality: "intact" } },
};
for (const [quality, uniqueName] of Object.entries(LITH_A1) as Array<[RelicQuality, string]>) {
  relics.groups["Lith A1"].qualities[quality] = { uniqueName, rewards: REWARDS };
  relics.byUniqueName[uniqueName] = { groupKey: "Lith A1", quality };
}

const inventory: RawInventoryData = {
  Suits: [],
  LevelKeys: [{ ItemType: LITH_A1.intact, ItemCount: 3 }],
};

function storedView(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

test("a relic popup switches between the simple and detailed view and remembers it", async () => {
  test.setTimeout(180_000);
  const testInfo = test.info();
  const pageErrors: string[] = [];
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-relic-view-switch-", {
      inventory,
      storage: {
        "baro-wishlist-v1": JSON.stringify({ [LITH_A1.intact]: 1, [NO_REWARDS]: 1 }),
        "baro-wishlist-alerts": "0",
      },
      onPage: async (page) => {
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.addInitScript(() => {
          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (new URL(url, location.href).pathname !== "/v1/baro-history")
              return nativeFetch(input, init);
            return Promise.resolve(new Response("{}", { status: 404 }));
          };
        });
      },
    });
    const { app, page } = harness;
    await evaluateInMain(
      app,
      ({ ipcMain }, payload) => {
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, () => payload.data);
      },
      { channel: DB_GET_RELIC_DATABASE, data: relics },
    );
    await page.reload();
    await setLayoutViewport(page, 1440, 900);

    const itemPopup = page.locator("[data-item-detail]");
    const relicPopup = page.locator("[data-relic-detail]");
    const dialogs = page.locator('.detail-overlay[role="dialog"]');
    const segment = (view: string) =>
      page.locator(`[data-relic-view-switch] [data-segment-value="${view}"]`);

    // Nothing remembered yet: the Relics tab keeps opening the breakdown.
    await openView(page, "relics");
    const card = page.locator(".relic-compact-head").first();
    await card.click();
    await expect(relicPopup).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-relic-view-switch="detailed"]')).toBeVisible();
    await expect(segment("detailed")).toHaveAttribute("aria-pressed", "true");
    expect(await storedView(page)).toBeNull();

    await segment("simple").click();
    await expect(itemPopup).toBeVisible();
    await expect(relicPopup).toHaveCount(0);
    await expect(dialogs).toHaveCount(1);
    await expect(segment("simple")).toHaveAttribute("aria-pressed", "true");
    expect(await storedView(page)).toBe("simple");
    await page.screenshot({
      path: testInfo.outputPath("relic-view-simple.png"),
      animations: "disabled",
    });

    await page.keyboard.press("Escape");
    await expect(dialogs).toHaveCount(0);

    // The remembered simple view now wins over the Relics tab's own popup.
    await card.click();
    await expect(itemPopup).toBeVisible();
    await expect(relicPopup).toHaveCount(0);

    await segment("detailed").click();
    await expect(relicPopup).toBeVisible();
    await expect(itemPopup).toHaveCount(0);
    await expect(dialogs).toHaveCount(1);
    expect(await storedView(page)).toBe("detailed");
    await relicPopup.locator(".detail-close").click();
    await expect(dialogs).toHaveCount(0);

    // The Baro planner opens the item popup, and now follows the remembered breakdown.
    await openView(page, "world");
    await page.locator('#content .view.active [data-tour-tab="baro"]').click();
    const planner = page.locator("[data-baro-planner]");
    await expect(planner).toBeVisible();
    await planner.locator('[data-baro-filter="wishlist"]').click();
    await planner.locator(`[data-baro-open="${LITH_A1.intact}"]`).click();
    await expect(relicPopup).toBeVisible();
    await expect(itemPopup).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("relic-view-detailed-from-baro.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(dialogs).toHaveCount(0);

    // A relic without reward rows keeps the item popup and offers no breakdown.
    await planner.locator(`[data-baro-open="${NO_REWARDS}"]`).click();
    await expect(itemPopup).toBeVisible();
    await expect(relicPopup).toHaveCount(0);
    await expect(page.locator("[data-relic-view-switch]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialogs).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
