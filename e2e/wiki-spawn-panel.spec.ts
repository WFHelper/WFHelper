import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
} from "./electronTestHarness";

test("a location search names where the searched enemy spawns", async () => {
  const harness = await launchElectronTestHarness("wf-wiki-spawn-panel-", {
    userDataFiles: {
      "drop-data-cache.json": {
        version: 2,
        hash: "spawn-panel-fixture",
        updatedAt: "2026-09-08T00:00:00.000Z",
        rows: [],
      },
    },
  });
  try {
    const { page } = harness;
    await setLayoutViewport(page, 1400, 900);
    await openView(page, "wiki");
    await page.locator('[data-wiki-mode="place"]').click();
    await page.locator("[data-search-focus]").fill("Swarm Mutalist Moa");

    const panel = page.locator("[data-wiki-spawn-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-wiki-spawn-group]").first()).toContainText("Mercury");
    await expect(panel).toContainText("Where it spawns");

    // The codex names 15 planets; the node table says where on them.
    const nodeRows = panel.locator("[data-enemy-nodes] [data-enemy-node-row]");
    await expect(nodeRows).toHaveCount(12);
    await page.screenshot({ path: test.info().outputPath("wiki-spawn-panel.png") });
    await panel.locator("[data-enemy-nodes-toggle]").click();
    expect(await nodeRows.count()).toBeGreaterThan(12);
    for (const [nodeId, name] of [
      ["SolNode162", "Isos"],
      ["SolNode153", "Brugia"],
    ]) {
      const cells = panel.locator(`[data-enemy-node-row="${nodeId}"] td`);
      await expect(cells.nth(0)).toHaveText("Eris");
      await expect(cells.nth(1)).toHaveText(name);
    }
    await expect(panel.locator('[data-enemy-node-row="ClanNode3"] td').nth(2)).toHaveText(
      "Excavation (Dark Sector)",
    );
    await panel.locator('[data-enemy-node-row="SolNode162"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("wiki-spawn-nodes-expanded.png") });
    await panel.locator("[data-enemy-nodes-toggle]").click();
    await expect(nodeRows).toHaveCount(12);

    // The exact entry wins over the longer name that contains it.
    await expect(panel.locator('[data-wiki-spawn-enemy="Swarm Mutalist MOA"]')).toBeVisible();
    await panel.locator("[data-wiki-spawn-enemy]").click();
    await expect(page.locator("[data-enemy-modal]")).toBeVisible();
    await expect(page.locator(".detail-panel [data-enemy-node-row]")).toHaveCount(12);
    await page.locator(".detail-close").click();

    await page.locator('[data-wiki-mode="item"]').click();
    await expect(panel).toHaveCount(0);
    await page.locator('[data-wiki-mode="place"]').click();
    await expect(panel).toBeVisible();
    // A location no enemy is named after keeps the rows alone, with no panel.
    await page.locator("[data-search-focus]").fill("Cetus Bounty");
    await expect(panel).toHaveCount(0);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
