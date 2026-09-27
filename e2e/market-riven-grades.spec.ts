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

import {
  RIVEN_ROLL_RESULT,
  RIVEN_SIMILAR_LISTINGS,
  RIVENS_SEARCH_AUCTIONS,
} from "../config/shared/ipcChannels";
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
    await expect(auctionCard).toContainText("−30% Zoom");
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

  test("the riven overlay, the modal and Settings share one Auctions setting", async () => {
    const callRivenOverlay = (fn: string, ...args: unknown[]) =>
      evaluateInMain(
        app,
        ({ app: electronApp }, payload) => {
          const moduleApi = process.getBuiltinModule("module") as {
            createRequire: (filename: string) => (id: string) => Record<string, unknown>;
          };
          const load = moduleApi.createRequire(
            `${electronApp.getAppPath()}/.electron-build/main.js`,
          );
          // No game is running, so the card scan must not answer for the injected roll.
          load("./ipc/overlay/rivenScan.js").scanInitialCard = () => new Promise(() => {});
          const target = load("./ipc/rivenOverlayIpc.js")[payload.fn];
          if (typeof target !== "function") throw new Error(`missing export ${payload.fn}`);
          target(...payload.args);
        },
        { fn, args },
      );
    const sendToPanels = (channel: string, payload: unknown) =>
      evaluateInMain(
        app,
        ({ BrowserWindow }, arg) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (win.webContents.getURL().includes("riven-overlay.html")) {
              win.webContents.send(arg.channel, arg.payload);
            }
          }
        },
        { channel, payload },
      );
    const panel = async (side: "left" | "right"): Promise<Page> => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = app.windows().find((win) => win.url().includes(`side=${side}`));
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`riven ${side} panel never opened`);
    };
    const serveListings = (listings: unknown[]) =>
      evaluateInMain(
        app,
        ({ ipcMain }, payload) => {
          ipcMain.removeHandler(payload.channel);
          ipcMain.handle(payload.channel, () => payload.listings);
        },
        { channel: RIVENS_SEARCH_AUCTIONS, listings },
      );
    const rolled = [
      { name: "Critical Damage", value: 120.5, positive: true },
      { name: "Multishot", value: 88.2, positive: true },
      { name: "Zoom", value: 31.4, positive: false },
    ];

    await serveListings(SIMILAR_LISTINGS);
    await callRivenOverlay("onRivenSessionOpen");
    await callRivenOverlay("setRivenInteractiveMode", true);
    const left = await panel("left");
    const right = await panel("right");
    const panels = [left, right];
    for (const win of panels) {
      await expect(win.locator("#weapon-name")).toHaveText("Riven", { timeout: 30_000 });
    }
    await sendToPanels(RIVEN_ROLL_RESULT, { rollCount: 1, left: rolled, right: rolled });
    await sendToPanels(RIVEN_SIMILAR_LISTINGS, SIMILAR_LISTINGS);

    const toggle = (win: Page) => win.locator("#btn-similar-auctions");
    const shoot = async (win: Page, name: string) => {
      await win.mouse.move(0, 0);
      await win.screenshot({ animations: "disabled", path: test.info().outputPath(name) });
    };
    const cards = (win: Page) => win.locator(".listing-card");
    const auction = (win: Page) => win.locator(`.listing-card[data-auction-id="${AUCTION_ID}"]`);
    for (const win of panels) {
      await expect(cards(win)).toHaveCount(3);
      await expect(toggle(win)).toHaveAttribute("aria-pressed", "true");
      await expect(toggle(win)).toHaveText("Auctions");
      await expect(auction(win)).toHaveCount(1);
    }
    await expect(auction(left).locator(".listing-stat-value")).toHaveText([
      "+110%",
      "+80%",
      "−30%",
    ]);
    await shoot(left, "riven-overlay-auctions-on.png");

    await toggle(left).click();
    for (const win of panels) {
      await expect(toggle(win)).toHaveAttribute("aria-pressed", "false");
      await expect(cards(win)).toHaveCount(2);
      await expect(auction(win)).toHaveCount(0);
    }
    await shoot(left, "riven-overlay-auctions-off.png");

    const chip = page.locator("[data-similar-auctions-toggle]");
    await page.locator(`[data-contract-grade="${GRADED_ID}"]`).click();
    await expect(chip).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
    await expect(page.locator("[data-similar-listing]")).toHaveCount(2);
    await expect(page.locator(`[data-similar-listing="${AUCTION_ID}"]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(chip).toHaveCount(0);

    const setting = page.locator('[data-setting="rivenSimilarAuctions"] input[type=checkbox]');
    await page.locator('#sidebar [data-view="settings"]').click();
    await page.locator('[data-tour-tab="overlay"]').click();
    await expect(setting).not.toBeChecked({ timeout: 20_000 });

    await toggle(right).click();
    await expect(setting).toBeChecked();
    for (const win of panels) await expect(cards(win)).toHaveCount(3);

    await setting.uncheck();
    for (const win of panels) {
      await expect(toggle(win)).toHaveAttribute("aria-pressed", "false");
      await expect(cards(win)).toHaveCount(2);
    }
    await setting.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("settings-riven-auctions.png"),
    });

    // Only an auction left: the list says so and the toggle stays reachable.
    await sendToPanels(RIVEN_SIMILAR_LISTINGS, [similarListing(AUCTION_ID, false)]);
    for (const win of panels) {
      await expect(win.locator(".listing-empty")).toHaveText("No similar rivens found");
      await expect(cards(win)).toHaveCount(0);
      await expect(toggle(win)).toBeVisible();
    }
    await shoot(left, "riven-overlay-auctions-empty.png");
    await toggle(left).click();
    for (const win of panels) {
      await expect(auction(win)).toHaveCount(1);
      await expect(win.locator(".listing-empty")).toHaveCount(0);
    }
    await expect(setting).toBeChecked();

    await callRivenOverlay("onRivenSessionClose");
  });
});
