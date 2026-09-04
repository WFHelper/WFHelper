import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  type ElectronTestHarness,
} from "./electronTestHarness";

// An unveiled riven is an Upgrades entry whose fingerprint carries a weapon
// compat plus buffs/curses; a veiled one carries a challenge instead.
const MAX_ROLL_INT = 0x3fffffff;
// The card carries the riven's inventory ItemId, so a locator built from these
// stays valid under translation and in both card sizes.
const RIFLE_RIVEN_ID = "aaaaaaaaaaaaaaaaaaaaaaa1";
const PISTOL_RIVEN_ID = "aaaaaaaaaaaaaaaaaaaaaaa2";

function riven(itemType: string, oid: string, compat: string) {
  return {
    ItemType: `/Lotus/Upgrades/Mods/Randomized/${itemType}`,
    ItemId: { $oid: oid },
    UpgradeFingerprint: JSON.stringify({
      compat,
      lim: 0,
      lvlReq: 9,
      lvl: 8,
      rerolls: 2,
      pol: "AP_ATTACK",
      buffs: [{ Tag: "WeaponFireDamageMod", Value: Math.round(MAX_ROLL_INT * 0.72) }],
      curses: [{ Tag: "WeaponFireRateMod", Value: Math.round(MAX_ROLL_INT * 0.3) }],
    }),
  };
}

function inventory() {
  return {
    Suits: [],
    Upgrades: [
      riven("LotusRifleRandomModRare", RIFLE_RIVEN_ID, "/Lotus/Weapons/Tenno/Rifle/Rifle"),
      riven("LotusPistolRandomModRare", PISTOL_RIVEN_ID, "/Lotus/Weapons/Tenno/Pistol/HeavyPistol"),
    ],
  };
}

test.describe("riven card size", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-riven-cards-", { inventory: inventory() });
    await openView(harness.page, "rivens");
    await expect(harness.page.locator("[data-riven-card]").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("starts on full cards and switches to compact", async () => {
    const page = harness!.page;

    const grid = page.locator("[data-riven-card-size]");
    await expect(grid).toHaveAttribute("data-riven-card-size", "full");
    const fullCards = await page.locator("[data-riven-card]").count();
    expect(fullCards).toBe(2);

    const rifleCard = page.locator(`[data-riven-card="${RIFLE_RIVEN_ID}"]`);
    await expect(rifleCard).toBeVisible();
    await expect(rifleCard.locator("[data-riven-grade]")).toHaveText(/^[SABCF][+-]?$/);

    // SegmentedControl renders the options in store order: full, then compact.
    await page.locator("[data-riven-card-size-control] button").nth(1).click();

    await expect(grid).toHaveAttribute("data-riven-card-size", "compact");
    await expect(page.locator("[data-riven-card]")).toHaveCount(fullCards);

    await expect(rifleCard).toBeVisible();
    await expect(rifleCard.locator("[data-riven-grade]")).toHaveText(/^[SABCF][+-]?$/);
    await expect(rifleCard.locator("[data-riven-copy-tag]")).toBeVisible();
  });

  test("keeps the compact choice across a reload", async () => {
    const page = harness!.page;

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await openView(page, "rivens");

    await expect(page.locator("[data-riven-card-size]")).toHaveAttribute(
      "data-riven-card-size",
      "compact",
      { timeout: 30_000 },
    );
    await expect(page.locator("[data-riven-card]")).toHaveCount(2);
  });
});
