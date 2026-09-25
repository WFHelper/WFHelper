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

interface SeededReward {
  uniqueName: string;
  name: string;
  /** One drop-table location per relic, in drop-table order. */
  relicLocations: string[];
  /** Set when the reward is a component of this item rather than an item itself. */
  parentUniqueName?: string;
}

/** The reward and the relics it drops from all come from the shipped database,
 *  so the fixture cannot drift from whatever the drop tables say today. */
async function readRewardWithRelicDrops(
  page: Page,
  minRelics = 1,
  parentPrefix: string | null = null,
): Promise<SeededReward> {
  const reward = await page.evaluate(
    async ({ minRelics, parentPrefix }) => {
      interface Entry {
        name?: string;
        uniqueName?: string;
        drops?: Array<{ location?: string }>;
        components?: Entry[];
      }
      const db = (await window.api.getItemDatabase()) as unknown as Record<string, Entry>;
      const relicLocations = (entry: Entry): string[] => {
        const byRelic = new Map<string, string>();
        for (const drop of entry.drops ?? []) {
          const location = String(drop.location ?? "");
          const relic = /^(Lith|Meso|Neo|Axi) [A-Z]+\d+(?= Relic)/.exec(location)?.[0];
          if (relic && !byRelic.has(relic)) byRelic.set(relic, location);
        }
        return [...byRelic.values()];
      };
      for (const [uniqueName, entry] of Object.entries(db)) {
        if (!entry?.name) continue;
        if (parentPrefix === null) {
          const locations = relicLocations(entry);
          if (locations.length >= minRelics) {
            return { uniqueName, name: entry.name, relicLocations: locations };
          }
          continue;
        }
        if (!uniqueName.startsWith(parentPrefix)) continue;
        for (const component of entry.components ?? []) {
          const locations = relicLocations(component);
          if (component.name && component.uniqueName && locations.length >= minRelics) {
            return {
              uniqueName: component.uniqueName,
              name: component.name,
              relicLocations: locations,
              parentUniqueName: uniqueName,
            };
          }
        }
      }
      return null;
    },
    { minRelics, parentPrefix },
  );

  expect(reward, `nothing in the item database drops from ${minRelics} relics`).not.toBeNull();
  return reward as SeededReward;
}

function relicIdentity(location: string) {
  const [tier, code] = location.replace(/\s*Relic.*$/i, "").split(/\s+/);
  const projection = `/Lotus/Types/Game/Projections/${tier}${code}`;
  return {
    tier,
    code,
    key: `${tier} ${code}`,
    intact: `${projection}_intact`,
    radiant: `${projection}_radiant`,
  };
}

function relicFixture(reward: SeededReward, locations: readonly string[]): RelicDatabase {
  const rewards = [
    {
      name: reward.name,
      uniqueName: reward.uniqueName,
      rarity: "common",
      chance: 25.33,
      urlName: null,
      ducats: 15,
    },
  ];
  const db: RelicDatabase = { groups: {}, byUniqueName: {} };
  for (const location of locations) {
    const { tier, code, key, intact, radiant } = relicIdentity(location);
    db.groups[key] = {
      key,
      name: key,
      tier,
      code,
      imageUrl: null,
      // Unvaulted on purpose: the badge has to say so rather than stay blank.
      vaulted: false,
      qualities: {
        intact: { uniqueName: intact, rewards },
        radiant: { uniqueName: radiant, rewards },
      },
    };
    db.byUniqueName[intact] = { groupKey: key, quality: "intact" };
    db.byUniqueName[radiant] = { groupKey: key, quality: "radiant" };
  }
  return db;
}

test("a drop source names the relic's vault state and how many are held", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-drop-relics-", { inventory: { Suits: [] } });
    const page = harness.page;
    const reward = await readRewardWithRelicDrops(page);
    const relic = relicIdentity(reward.relicLocations[0]);

    writeHarnessInventory(harness, {
      Suits: [],
      LevelKeys: [
        { ItemType: relic.intact, ItemCount: 3 },
        { ItemType: relic.radiant, ItemCount: 2 },
      ],
    });
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, payload) => {
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, () => payload.data);
      },
      { channel: DB_GET_RELIC_DATABASE, data: relicFixture(reward, [reward.relicLocations[0]]) },
    );
    await page.reload();
    await setLayoutViewport(page, 1440, 900);
    await openView(page, "relics");

    // Reward row to component panel is the path a player takes from a missing
    // part, and that panel is where the drop sources are listed.
    await page.locator(".relic-compact-head").first().click();
    const rewardRows = page.locator(".relic-rewards-list");
    await expect(rewardRows).toBeVisible({ timeout: 30_000 });
    await rewardRows.locator("button").first().click();

    const panel = page.locator(".relic-reward-item-panel");
    // A prime part drops from dozens of relics and the list starts capped.
    const showAll = panel.locator("[data-drops-show-all]");
    await expect(panel.locator(".detail-acquisition")).toBeVisible({ timeout: 30_000 });
    if (await showAll.count()) await showAll.click();
    const row = panel.locator(".detail-acquisition button", { hasText: relic.key }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Unvaulted reads as U, and only the refinements actually held get a chip.
    await expect(row.locator("[data-relic-vault]")).toHaveAttribute(
      "data-relic-vault",
      "unvaulted",
    );
    await expect(row.locator('[data-relic-owned="intact"]')).toHaveText(/3/);
    await expect(row.locator('[data-relic-owned="radiant"]')).toHaveText(/2/);
    await expect(row.locator('[data-relic-owned="exceptional"]')).toHaveCount(0);
    await expect(row.locator('[data-relic-owned="flawless"]')).toHaveCount(0);
    const chips = await row.locator("[data-relic-owned]").allInnerTexts();
    expect(chips.join(" ")).not.toContain("relics.qualityShort.");

    await row.scrollIntoViewIfNeeded();
    await panel.screenshot({
      animations: "disabled",
      path: test.info().outputPath("drop-source-relics.png"),
    });

    // The popover behind the row repeats both, and no longer calls a relic the
    // player does not own vaulted.
    await row.click();
    const popover = panel.locator("[data-relic-popover-vault]");
    await expect(popover).toHaveAttribute("data-relic-popover-vault", "unvaulted");
    await popover.scrollIntoViewIfNeeded();
    await panel.screenshot({
      animations: "disabled",
      path: test.info().outputPath("drop-source-relics-popover.png"),
    });
  } finally {
    await closeElectronTestHarness(harness);
  }
});

test("item details list a held relic first before Relics has ever opened", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-drop-relics-first-", {
      inventory: { Suits: [] },
    });
    const page = harness.page;
    const part = await readRewardWithRelicDrops(page, 2, "/Lotus/Powersuits/");
    const listedFirst = relicIdentity(part.relicLocations[0]);
    const heldLocation = part.relicLocations[part.relicLocations.length - 1];
    const held = relicIdentity(heldLocation);

    writeHarnessInventory(harness, {
      Suits: [{ ItemType: part.parentUniqueName, XP: 0 }],
      LevelKeys: [{ ItemType: held.intact, ItemCount: 3 }],
    });
    // Startup reads the inventory well before the relic database; holding the
    // database back until the drop list is open pins that order.
    const releaseEvent = "e2e-release-relic-db";
    await evaluateInMain(
      harness.app,
      ({ ipcMain }, payload) => {
        const released = new Promise<void>((resolve) => {
          ipcMain.once(payload.releaseEvent, () => resolve());
        });
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, async () => {
          await released;
          return payload.data;
        });
      },
      {
        channel: DB_GET_RELIC_DATABASE,
        releaseEvent,
        data: relicFixture(part, [part.relicLocations[0], heldLocation]),
      },
    );
    await page.reload();
    await setLayoutViewport(page, 1440, 900);
    await openView(page, "inventory");
    await page.locator('[data-tour-tab="equipment"]').click();
    const card = page.locator(`[data-inventory-card="${part.parentUniqueName}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.locator(".expand-link").click();
    await page
      .locator(".detail-components button", { has: page.getByText(part.name, { exact: true }) })
      .click();

    const panel = page.locator(".comp-inline-panel");
    const drops = panel.locator(".detail-acquisition");
    await expect(drops).toBeVisible({ timeout: 30_000 });
    const showAll = panel.locator("[data-drops-show-all]");
    if (await showAll.count()) await showAll.click();
    await evaluateInMain(harness.app, ({ ipcMain }, event) => ipcMain.emit(event), releaseEvent);

    const rows = drops.locator("button");
    const heldName = `${held.key} Relic`;
    await expect(rows.first().getByText(heldName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(rows.first().locator('[data-relic-owned="intact"]')).toHaveText(/3/);
    await expect(rows.filter({ has: page.getByText(heldName, { exact: true }) })).toHaveCount(1);
    await expect(
      rows.filter({ has: page.getByText(`${listedFirst.key} Relic`, { exact: true }) }),
    ).toHaveCount(1);

    await panel.screenshot({
      animations: "disabled",
      path: test.info().outputPath("drop-source-relics-held-first.png"),
    });
  } finally {
    await closeElectronTestHarness(harness);
  }
});
