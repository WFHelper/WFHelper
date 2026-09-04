import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

const SUNIKA = "/Lotus/Types/Game/KubrowPet/HunterKubrowPetPowerSuit";
const COLORS = "/Lotus/Types/Game/KubrowPet/Colors";
const PATTERNS = "/Lotus/Types/Game/KubrowPet/Patterns";
const BODY_TYPES = "/Lotus/Types/Game/KubrowPet/BodyTypes";

function dominantTraits() {
  return {
    BaseColor: `${COLORS}/KubrowPetColorMundaneA`,
    SecondaryColor: `${COLORS}/KubrowPetColorMundaneB`,
    TertiaryColor: `${COLORS}/KubrowPetColorMidB`,
    AccentColor: `${COLORS}/KubrowPetColorVibrantG`,
    EyeColor: `${COLORS}/KubrowPetColorEyesG`,
    FurPattern: `${PATTERNS}/KubrowPetPatternA`,
    BodyType: `${BODY_TYPES}/KubrowPetThinBodyType`,
    Personality: SUNIKA,
  };
}

function recessiveTraits() {
  return {
    BaseColor: `${COLORS}/KubrowPetColorVibrantA`,
    SecondaryColor: `${COLORS}/KubrowPetColorMundaneD`,
    TertiaryColor: `${COLORS}/KubrowPetColorMundaneF`,
    AccentColor: `${COLORS}/KubrowPetColorMidE`,
    EyeColor: `${COLORS}/KubrowPetColorEyesB`,
    FurPattern: `${PATTERNS}/KubrowPetPatternC`,
    BodyType: `${BODY_TYPES}/KubrowPetRegularBodyType`,
    Personality: SUNIKA,
  };
}

function inventory() {
  return {
    Suits: [],
    // A plain Kubrow carries no ModularParts; the genetics live in Details.
    KubrowPets: [
      {
        ItemType: SUNIKA,
        ItemId: { $oid: "0000feed0000feed0000feed" },
        XP: 0,
        Details: {
          Name: "Fixture Kubrow",
          IsPuppy: false,
          HasCollar: true,
          PrintsRemaining: 2,
          Status: "STATUS_STASIS",
          HatchDate: { $date: { $numberLong: "1700000000000" } },
          IsMale: true,
          Size: 1.0625,
          DominantTraits: dominantTraits(),
          RecessiveTraits: recessiveTraits(),
        },
      },
    ],
    KubrowPetPrints: [
      {
        ItemType: "/Lotus/Types/Game/KubrowPet/ImprintedTraitPrint",
        ItemId: { $oid: "0000cafe0000cafe0000cafe" },
        Name: "Fixture Kubrow",
        IsMale: true,
        Size: 1.0625,
        DominantTraits: dominantTraits(),
        RecessiveTraits: recessiveTraits(),
      },
    ],
  };
}

test.describe("pet genetics", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-pets-", { inventory: inventory() });
    await harness.page.locator('#sidebar [data-view="inventory"]').click();
    await harness.page.locator('[data-tour-tab="equipment"]').click();
    await expect(harness.page.locator(".item-card").first()).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("shows a hatched Kubrow as a companion row", async () => {
    const page = harness!.page;
    const card = page.locator(".item-card").filter({ hasText: "Sunika Kubrow" }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator(".item-type")).toContainText("Companion");
  });

  test("renders the genetics with colour swatches and the stored imprint", async () => {
    const page = harness!.page;
    const card = page.locator(".item-card").filter({ hasText: "Sunika Kubrow" }).first();
    await card.hover();
    await card.locator(".expand-link").click();

    const modal = page.locator(".detail-panel").first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const genetics = modal.locator("[data-pet-genetics]");
    await expect(genetics).toBeVisible({ timeout: 15_000 });
    await expect(genetics.locator("[data-pet-instance]")).toHaveCount(1);
    expect(await genetics.locator("[data-pet-swatch]").count()).toBeGreaterThanOrEqual(4);
    await expect(genetics.locator("[data-pet-imprint]")).toHaveCount(1);

    await page.keyboard.press("Escape");
  });
});
