import { expect, test, type Page } from "@playwright/test";

import { DB_GET_RELIC_DATABASE } from "../config/shared/ipcChannels";
import type { RelicDatabase, RelicQuality } from "../src/types/relics";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const relics: RelicDatabase = { groups: {}, byUniqueName: {} };
const inventory = { Suits: [], LevelKeys: [] as { ItemType: string; ItemCount: number }[] };
for (const [code, counts] of [
  ["A1", [40, 0, 0, 1]],
  ["B2", [1, 2, 3, 9]],
  ["C3", [10, 0, 0, 0]],
] as const) {
  const key = `Lith ${code}`;
  const qualities: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];
  relics.groups[key] = { key, name: key, tier: "Lith", code, imageUrl: null, qualities: {} };
  qualities.forEach((quality, index) => {
    const uniqueName = `/Lotus/Types/Game/Projections/${code}_${quality}`;
    relics.groups[key].qualities[quality] = { uniqueName, rewards: [] };
    relics.byUniqueName[uniqueName] = { groupKey: key, quality };
    inventory.LevelKeys.push({ ItemType: uniqueName, ItemCount: counts[index] });
  });
}

test.describe("relic planner copies and owned sort", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-relic-owned-", { inventory });
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, payload) => {
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, () => payload.data);
      },
      { channel: DB_GET_RELIC_DATABASE, data: relics },
    );
    page = harness.page;
    await page.reload();
    await setLayoutViewport(page, 1440, 900);
    await openView(page, "relics");
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("relic Copies filter hides relics at or below the chosen count", async () => {
    const copies = page.locator("[data-relic-owned-above]");
    const quality = page.locator("[data-relic-quality]");
    const names = page.locator(".relic-row-name");
    await expect(names).toHaveText(["Lith A1", "Lith B2", "Lith C3"]);

    // Totals are 41, 15 and 10 copies.
    await copies.selectOption({ label: "More than 10" });
    await expect(names).toHaveText(["Lith A1", "Lith B2"]);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("relic-copies-more-than-10.png"),
    });

    // The quality select must not change which relics the threshold keeps.
    await quality.selectOption("radiant");
    await expect(names).toHaveText(["Lith A1", "Lith B2"]);

    await copies.selectOption({ label: "Any" });
    await expect(names).toHaveText(["Lith A1", "Lith B2", "Lith C3"]);
  });

  test("relic Owned sort defaults descending and follows the selected refinement", async () => {
    const sort = page.locator('[data-tour="relic-filters"] .sort-control-select');
    const quality = page.locator("[data-relic-quality]");
    const names = page.locator(".relic-row-name");
    await quality.selectOption("owned");
    await sort.selectOption("owned");
    await expect(names).toHaveText(["Lith A1", "Lith B2", "Lith C3"]);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("relic-owned-total.png"),
    });
    await quality.selectOption("radiant");
    await expect(names).toHaveText(["Lith B2", "Lith A1", "Lith C3"]);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("relic-owned-radiant.png"),
    });
    await page.locator('[data-tour="relic-filters"] .sort-control-direction').click();
    await expect(names).toHaveText(["Lith C3", "Lith A1", "Lith B2"]);
    await sort.selectOption("name");
    await sort.selectOption("owned");
    await expect(names).toHaveText(["Lith B2", "Lith A1", "Lith C3"]);
    await quality.selectOption("owned");
    await expect(names).toHaveText(["Lith A1", "Lith B2", "Lith C3"]);
  });
});
