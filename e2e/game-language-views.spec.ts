import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACRID = "/Lotus/Weapons/ClanTech/Bio/AcidDartPistol";
const ADRAMALIUM = "/Lotus/Types/Items/Gems/Deimos/DeimosCommonOreAItem";
const MAG_PRIME = "/Lotus/Powersuits/Mag/MagPrime";
const AEOLAK_BARREL_BLUEPRINT =
  "/Lotus/Types/Recipes/Weapons/WeaponParts/DuviriRifleBarrelBlueprint";

const WARFRAME_RECIPES = "/Lotus/Types/Recipes/WarframeRecipes";

function inventory() {
  return {
    Suits: [{ ItemType: MAG_PRIME, XP: 0 }],
    Pistols: [{ ItemType: ACRID, XP: 0 }],
    MiscItems: [
      { ItemType: ADRAMALIUM, ItemCount: 949 },
      // A full Mag Prime set, so the Full Sets tab has a row to name.
      { ItemType: `${WARFRAME_RECIPES}/MagPrimeBlueprint`, ItemCount: 2 },
      { ItemType: `${WARFRAME_RECIPES}/MagPrimeChassisBlueprint`, ItemCount: 2 },
      { ItemType: `${WARFRAME_RECIPES}/MagPrimeHelmetBlueprint`, ItemCount: 2 },
      { ItemType: `${WARFRAME_RECIPES}/MagPrimeSystemsBlueprint`, ItemCount: 2 },
    ],
    Recipes: [{ ItemType: AEOLAK_BARREL_BLUEPRINT, ItemCount: 1 }],
  };
}

async function selectGameLanguage(page: ElectronTestHarness["page"], code: string) {
  await page.locator('#sidebar [data-view="settings"]').click();
  const select = page.locator('[data-setting="game-language"] select');
  await expect(select).toBeVisible();
  await select.selectOption(code);
}

// Every one of these panels joins on the English key, so a panel that draws that
// key instead of the localized name sits English beside a localized card.
test("every inventory panel reads its names in the game language", async () => {
  test.setTimeout(240_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-gamelang-views-", { inventory: inventory() });
    const { page } = harness;

    await selectGameLanguage(page, "ko");

    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('[data-tour="inventory-tabs"] [data-tour-tab="equipment"]').click();
    await expect(page.locator(".item-name").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".item-name").filter({ hasText: "아크리드" })).toHaveCount(1);

    // "Set" is our word; only the item half of the label follows the language.
    await page.locator('[data-tour="inventory-tabs"] [data-tour-tab="full_sets"]').click();
    await expect(page.locator(".item-name").filter({ hasText: "매그 프라임 Set" })).toHaveCount(1);

    await page.locator('[data-tour="inventory-tabs"] [data-tour-tab="resources"]').click();
    await expect(page.locator(".resource-name").filter({ hasText: "아드라말륨" })).toHaveCount(1);

    await page.locator('#sidebar [data-view="foundry"]').click();
    await expect(page.getByText("아이올락 배럴", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.locator('#sidebar [data-view="mastery"]').click();
    await page.locator("#content .view.active [data-search-focus]").fill("Mag Prime");
    await expect(page.locator(".item-name").filter({ hasText: "매그 프라임" }).first()).toBeVisible(
      { timeout: 30_000 },
    );

    // The roadmap builds its own rows off the mastery payload, so it needs its
    // own check.
    await page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="roadmap"]').click();
    await expect(page.getByText("아크리드", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await closeElectronTestHarness(harness);
  }
});
