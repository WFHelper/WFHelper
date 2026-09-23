import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  restartElectronTestHarness,
  selectOptionValues,
  type ElectronTestHarness,
} from "./electronTestHarness";

function seededHit(
  id: string,
  at: string,
  platinum: number,
  extra: { kind?: "riven" | "item"; endo?: number; endoPerPlat?: number } = {},
): Record<string, unknown> {
  const kind = extra.kind ?? "riven";
  return {
    id,
    ruleId: "seed-rule",
    ruleName: "Seeded Rule",
    at,
    kind,
    title: `${kind === "item" ? "Item" : "Riven"}: Seeded Rule`,
    detail: `seeded ${id}`,
    url: `https://warframe.market/auction/${id}`,
    platinum,
    seller: `Seller-${id}`,
    sellerStatus: "ingame",
    ...(extra.endo !== undefined ? { endo: extra.endo } : {}),
    ...(extra.endoPerPlat !== undefined ? { endoPerPlat: extra.endoPerPlat } : {}),
  };
}

// Stored newest first. "legacy" predates the endo field and keeps only its ratio.
const SEEDED_HITS = {
  schema: 1,
  hits: [
    seededHit("rich", "2026-09-12T10:00:00.000Z", 100, { endo: 1500, endoPerPlat: 15 }),
    seededHit("item", "2026-09-12T09:00:00.000Z", 30, { kind: "item" }),
    seededHit("deal", "2026-09-12T08:00:00.000Z", 60, { endo: 2400, endoPerPlat: 40 }),
    seededHit("legacy", "2026-09-12T07:00:00.000Z", 45, { endoPerPlat: 11.4 }),
  ],
};

const EXPECTED = {
  newest: ["rich", "item", "deal", "legacy"],
  oldest: ["legacy", "deal", "item", "rich"],
  priceAsc: ["item", "legacy", "deal", "rich"],
  priceDesc: ["rich", "deal", "legacy", "item"],
  endoPerPlatDesc: ["deal", "rich", "legacy", "item"],
  endoPerPlatAsc: ["legacy", "rich", "deal", "item"],
  endoDesc: ["deal", "rich", "item", "legacy"],
  endoAsc: ["rich", "deal", "item", "legacy"],
};

async function openHitHistory(page: Page): Promise<void> {
  await openView(page, "market");
  await page.locator('#content [data-tour-tab="alerts"]').first().click();
  await expect(page.locator("[data-alert-hit]")).toHaveCount(4, { timeout: 30_000 });
}

async function expectOrder(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator("[data-alert-hit]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-alert-hit"))),
    )
    .toEqual(ids);
}

test("the hit history sorts by time, price and endo and remembers the choice", async () => {
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-alert-hit-sort-", {
      userDataFiles: { "market-alert-hits.json": SEEDED_HITS },
    });
    await openHitHistory(harness.page);

    const sort = harness.page.locator("[data-alert-hit-sort]");
    await expect(sort).toBeVisible();
    expect(await selectOptionValues(sort)).toEqual(Object.keys(EXPECTED));
    await expect(sort).toHaveValue("newest");
    expect(await sort.innerText()).not.toContain("marketAlerts.");

    for (const [value, ids] of Object.entries(EXPECTED)) {
      await sort.selectOption(value);
      await expectOrder(harness.page, ids);
    }

    await sort.selectOption("priceAsc");
    await harness.page.screenshot({ path: test.info().outputPath("alert-hit-sort.png") });

    harness = await restartElectronTestHarness(harness);
    await openHitHistory(harness.page);
    await expect(harness.page.locator("[data-alert-hit-sort]")).toHaveValue("priceAsc");
    await expectOrder(harness.page, EXPECTED.priceAsc);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
