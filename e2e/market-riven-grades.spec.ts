import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { RIVENS_SEARCH_AUCTIONS } from "../config/shared/ipcChannels";
import { closeElectronApp, evaluateInMain } from "./electronTestHarness";
import { mainWindow } from "./mainWindow";

const GRADED_ID = "aaaaaaaaaaaaaaaaaaaaaaa1";
const UNKNOWN_ID = "aaaaaaaaaaaaaaaaaaaaaaa2";
const AUCTION_ID = "ccccccccccccccccccccccc1";

// Same attributes as the graded contract, so every listing clears the similarity cut.
function similarListing(id: string, isDirectSell: boolean) {
  return {
    id,
    seller: `Fixture Seller ${id.slice(-1)}`,
    sellerStatus: "ingame",
    platinum: isDirectSell ? 200 : 90,
    stats: [
      { name: "Critical Damage", value: 110, positive: true },
      { name: "Multishot", value: 80, positive: true },
      { name: "Zoom", value: -30, positive: false },
    ],
    rerolls: 5,
    startingPrice: isDirectSell ? null : 90,
    buyoutPrice: isDirectSell ? 200 : null,
    isDirectSell,
  };
}

const SIMILAR_LISTINGS = [
  similarListing("bbbbbbbbbbbbbbbbbbbbbbb1", true),
  similarListing(AUCTION_ID, false),
  similarListing("bbbbbbbbbbbbbbbbbbbbbbb2", true),
];

function attribute(urlName: string, label: string, value: number, positive: boolean) {
  return { urlName, label, value, positive };
}

// The normalized contract shape the renderer reads, as wfmContracts.ts builds it.
function contract(id: string, weaponUrlName: string, stats: unknown[]) {
  return {
    id,
    itemName: `${weaponUrlName} riven`,
    itemId: null,
    itemUrlName: `${weaponUrlName}_riven_mod`,
    weaponUrlName,
    rivenSuffix: "visitox",
    itemThumb: null,
    platinum: 150,
    buyoutPlatinum: 150,
    startingPlatinum: null,
    quantity: 1,
    visible: true,
    modRank: 8,
    rerolls: 12,
    masteryLevel: 14,
    polarity: "madurai",
    minimalReputation: 0,
    isDirectSell: true,
    listedAt: null,
    updatedAt: null,
    note: null,
    stats,
    listingUrl: `https://warframe.market/auction/${id}`,
    sourceType: "riven",
  };
}

function fixtureOrders() {
  return {
    sell: [],
    buy: [],
    contracts: [
      contract(GRADED_ID, "akstiletto", [
        attribute("critical_damage", "Critical Damage", 120.5, true),
        attribute("multishot", "Multishot", 88.2, true),
        attribute("zoom", "Zoom", -31.4, false),
      ]),
      contract(UNKNOWN_ID, "zzz_not_a_weapon", [
        attribute("critical_chance", "Critical Chance", 100, true),
      ]),
    ],
  };
}

test.describe("Market riven contract grades (fixture mode)", () => {
  test.setTimeout(240_000);

  let app: ElectronApplication;
  let page: Page;
  let sandboxDir: string;

  test.beforeAll(async () => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-riven-grades-e2e-"));
    const localAppData = path.join(sandboxDir, "local");
    fs.mkdirSync(localAppData, { recursive: true });
    const fixturePath = path.join(sandboxDir, "wfm-orders.json");
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureOrders()));

    const helperDir = path.join(sandboxDir, "user-data", "api-helper");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(helperDir, "inventory.json"), JSON.stringify({ Suits: [] }));

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.WFHELPER_DISABLE_KEYBOARD_HOOK = "1";
    env.WFHELPER_DISABLE_DBWIN = "1";
    env.LOCALAPPDATA = localAppData;
    env.APPDATA = path.join(sandboxDir, "roaming");
    env.WFHELPER_USER_DATA = path.join(sandboxDir, "user-data");
    env.WFHELPER_WFM_FIXTURES = fixturePath;

    app = await electron.launch({ args: ["--no-sandbox", "--lang=en-US", "."], env });
    page = await mainWindow(app);
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log("[renderer console]", msg.text());
    });

    await expect(page.locator("#app")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => {
      localStorage.setItem("setup-completed-v2", "1");
      localStorage.setItem("app-language", "en");
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });

    await page.locator('#sidebar [data-view="market"]').click();
    await page.locator('#content [data-tour-tab="rivens"]').click();
  });

  test.afterAll(async () => {
    await closeElectronApp(app, sandboxDir);
  });

  test("a listed riven shows the roll grade main computed for it", async () => {
    const badges = page.locator(`[data-contract-grade="${GRADED_ID}"]`);
    await expect(badges).toBeVisible({ timeout: 30_000 });
    await expect(badges.locator("[data-riven-grade]")).toHaveText(/^[SABCF][+-]?$/);
    await expect(badges.locator("[data-riven-attr-grade]")).toHaveCount(1);
  });

  test("a weapon main cannot resolve says so instead of leaving a gap", async () => {
    const badges = page.locator(`[data-contract-grade="${UNKNOWN_ID}"]`);
    await expect(badges).toBeVisible({ timeout: 30_000 });
    await expect(badges.locator("[data-riven-grade]")).toHaveCount(0);
    await expect(badges.locator('[data-riven-attr-grade="?"]')).toHaveCount(1);
  });

  test("the listing modal carries the same grades as the row", async () => {
    const rowGrade = await page
      .locator(`[data-contract-grade="${GRADED_ID}"] [data-riven-grade]`)
      .textContent();

    await page.locator(`[data-contract-grade="${GRADED_ID}"]`).click();
    const modalGrade = page.locator("[data-riven-detail-grade]");
    await expect(modalGrade).toBeVisible({ timeout: 20_000 });
    await expect(modalGrade).toHaveText(String(rowGrade));
    await expect(page.locator("[data-riven-stat-grade]")).toHaveCount(3);
    await page.keyboard.press("Escape");
  });

  test("the Auctions chip hides bidding auctions from similar rivens and stays off on reopen", async () => {
    const serveListings = (listings: unknown[]) =>
      evaluateInMain(
        app,
        ({ ipcMain }, payload) => {
          ipcMain.removeHandler(payload.channel);
          ipcMain.handle(payload.channel, () => payload.listings);
        },
        { channel: RIVENS_SEARCH_AUCTIONS, listings },
      );
    const openModal = () => page.locator(`[data-contract-grade="${GRADED_ID}"]`).click();
    const chip = page.locator("[data-similar-auctions-toggle]");
    const cards = page.locator("[data-similar-listing]");
    const auctionCard = page.locator(`[data-similar-listing="${AUCTION_ID}"]`);

    await serveListings(SIMILAR_LISTINGS);
    await openModal();
    await expect(cards).toHaveCount(3, { timeout: 20_000 });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(auctionCard).toHaveCount(1);
    await chip.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("riven-similar-auctions-on.png"),
    });

    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(cards).toHaveCount(2);
    await expect(auctionCard).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(chip).toHaveCount(0);

    await openModal();
    await expect(chip).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
    await expect(cards).toHaveCount(2);
    await expect(auctionCard).toHaveCount(0);
    await chip.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("riven-similar-auctions-off.png"),
    });
    await page.keyboard.press("Escape");

    // Only auctions left: the empty state shows and the chip stays reachable.
    await serveListings([similarListing(AUCTION_ID, false)]);
    await openModal();
    await expect(page.locator("[data-similar-empty]")).toBeVisible({ timeout: 20_000 });
    await chip.click();
    await expect(auctionCard).toHaveCount(1);
    await expect(page.locator("[data-similar-empty]")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
