import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  selectOptionValues,
  type ElectronTestHarness,
} from "./electronTestHarness";

// An unveiled riven is an Upgrades entry whose fingerprint carries a weapon
// compat plus buffs/curses; a veiled one carries a challenge instead.
const MAX_ROLL_INT = 0x3fffffff;
// The card carries the riven's inventory ItemId, so a locator built from these
// stays valid under translation and in both card sizes.
const RIFLE_RIVEN_ID = "aaaaaaaaaaaaaaaaaaaaaaa1";
const PISTOL_RIVEN_ID = "aaaaaaaaaaaaaaaaaaaaaaa2";

function riven(itemType: string, oid: string, compat: string, buff: number, curse: number) {
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
      buffs: [{ Tag: "WeaponFireDamageMod", Value: Math.round(MAX_ROLL_INT * buff) }],
      curses: [{ Tag: "WeaponFireRateMod", Value: Math.round(MAX_ROLL_INT * curse) }],
    }),
  };
}

// The overall grade is lerp(-10, 10, avg roll), curses counting inverted: the
// rifle rolls average 0.71 (A-) and the pistol 0.05 (C-), one card per letter.
function inventory() {
  return {
    Suits: [],
    Upgrades: [
      riven(
        "LotusRifleRandomModRare",
        RIFLE_RIVEN_ID,
        "/Lotus/Weapons/Tenno/Rifle/Rifle",
        0.72,
        0.3,
      ),
      riven(
        "LotusPistolRandomModRare",
        PISTOL_RIVEN_ID,
        "/Lotus/Weapons/Tenno/Pistol/HeavyPistol",
        0.05,
        0.95,
      ),
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

    // SegmentedControl renders the options in store order: full, compact.
    await openView(page, "settings");
    await page.locator('[data-tour-tab="appearance"]').click();
    await page.locator('[data-appearance-tab="theme"]').click();
    await page.locator("[data-riven-card-size-control] button").nth(1).click();
    await openView(page, "rivens");

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

  test("the grade dropdowns list every grade and narrow the cards", async () => {
    const page = harness!.page;

    const gradeSelect = page.locator("[data-riven-grade-filter] [data-riven-grade-select]");
    const attrGradeSelect = page.locator("[data-riven-attr-grade-select]");
    await expect(gradeSelect).toBeVisible({ timeout: 30_000 });

    expect(await selectOptionValues(gradeSelect)).toEqual(["all", "S", "A", "B", "C", "F"]);
    expect(await selectOptionValues(attrGradeSelect)).toEqual([
      "all",
      "Great",
      "Good",
      "OK",
      "Bad",
    ]);

    // The filter matches the letter family, so "C" keeps C+, C and C-.
    await gradeSelect.selectOption("C");
    await expect(page.locator("[data-riven-card]")).toHaveCount(1);
    await expect(
      page.locator(`[data-riven-card="${PISTOL_RIVEN_ID}"] [data-riven-grade]`),
    ).toHaveText(/^C[+-]?$/);

    await gradeSelect.selectOption("A");
    await expect(page.locator("[data-riven-card]")).toHaveCount(1);
    await expect(
      page.locator(`[data-riven-card="${RIFLE_RIVEN_ID}"] [data-riven-grade]`),
    ).toHaveText(/^A[+-]?$/);

    await gradeSelect.selectOption("all");
    await expect(page.locator("[data-riven-card]")).toHaveCount(2);
  });
});
