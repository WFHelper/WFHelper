import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";
import { createOfflineScenario } from "./offlineScenario";

const INVENTED_RELIC = "/Lotus/Types/Game/Projections/T4VoidProjectionZetaPrimeZ99Bronze";
const DOWNLOADED_VERSION = "1.1299.0";

interface BundledRelic {
  uniqueName: string;
  name: string;
  vaulted?: boolean;
  imageName?: string;
  drops?: unknown[];
  rewards?: Array<{
    chance: number;
    rarity: string;
    item?: { uniqueName?: string; name?: string; warframeMarket?: unknown };
  }>;
}

// The route's document: the bundled relics trimmed to the contract's fields, plus
// one relic the bundle lacks under a version above the bundled one.
function relicDocument(): unknown {
  const dataDir = path.join(process.cwd(), "node_modules", "@wfcd", "items", "data", "json");
  const bundled = JSON.parse(
    fs.readFileSync(path.join(dataDir, "Relics.json"), "utf8"),
  ) as BundledRelic[];
  const relics = bundled.map((relic) => ({
    uniqueName: relic.uniqueName,
    name: relic.name,
    vaulted: Boolean(relic.vaulted),
    ...(relic.imageName ? { imageName: relic.imageName } : {}),
    dropCount: relic.drops?.length ?? 0,
    rewards: (relic.rewards ?? []).map((reward) => ({
      chance: reward.chance,
      rarity: reward.rarity,
      item: {
        uniqueName: reward.item?.uniqueName ?? "",
        name: reward.item?.name,
        ...(reward.item?.warframeMarket ? { warframeMarket: reward.item.warframeMarket } : {}),
      },
    })),
  }));
  relics.push({
    uniqueName: INVENTED_RELIC,
    name: "Axi Z99 Intact",
    vaulted: false,
    dropCount: 4,
    rewards: [
      {
        chance: 2,
        rarity: "Rare",
        item: {
          uniqueName: "/Lotus/Types/Recipes/ZetaPrimeBlueprint",
          name: "Zeta Prime Blueprint",
        },
      },
    ],
  });
  return {
    ok: true,
    version: DOWNLOADED_VERSION,
    publishedAt: "2026-09-20T08:00:00.000Z",
    generatedAt: "2026-09-20T08:05:00.000Z",
    relics,
  };
}

test("newer downloaded relic data shows a relic the bundle lacks", async () => {
  test.setTimeout(180_000);
  const scenario = createOfflineScenario("world-darvo", [
    {
      pattern: "^https://api\\.wfhelper\\.com/v1/wfcd-relics$",
      status: 200,
      body: relicDocument(),
    },
    // Settings > About asks for its supporters panel.
    {
      pattern: "^https://api\\.wfhelper\\.com/v1/supporters(?:\\?|$)",
      status: 503,
      body: { error: "fixture_unavailable" },
    },
  ]);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-relic-data-", {
      ...scenario,
      inventory: { Suits: [], LevelKeys: [{ ItemType: INVENTED_RELIC, ItemCount: 2 }] },
    });
    const { page } = harness;
    await setLayoutViewport(page, 1440, 900);
    await openView(page, "relics");

    // Main applies the download a few seconds after startup and pushes relic-db-updated.
    await expect(page.locator(".relic-row-name")).toHaveText(["Axi Z99"], { timeout: 60_000 });
    await page.screenshot({ path: test.info().outputPath("relics-downloaded.png") });

    await openView(page, "settings");
    await page.locator('#content .view.active [data-tour-tab="about"]').click();
    const row = page.locator('[data-credit="relic-data"]');
    await expect(row).toContainText(`${DOWNLOADED_VERSION}, updated`);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("about-relic-data.png") });

    scenario.assertNoUnexpectedRequests();
  } finally {
    await closeElectronTestHarness(harness);
    scenario.dispose();
  }
});
