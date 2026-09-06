import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const PART_PREFIX = "/Lotus/Types/Recipes/Weapons/WeaponParts/";
// Tradable parts generate a market slug locally, so the panel renders its
// action row with no network. Enough of them to make the grid scroll.
const PARTS = [
  "AcceltraPrimeBarrel",
  "AcceltraPrimeReceiver",
  "AcceltraPrimeStock",
  "AfurisPrimeBarrel",
  "AfurisPrimeLink",
  "AfurisPrimeReceiver",
  "AkariusPrimeBarrel",
  "AkariusPrimeLink",
  "AkariusPrimeReceiver",
  "AkboltoPrimeBarrel",
  "AkboltoPrimeLink",
  "AkboltoPrimeReceiver",
  "AkjagaraPrimeBarrel",
  "AkjagaraPrimeLink",
  "AkjagaraPrimeReceiver",
  "AksomatiPrimeBarrel",
  "AksomatiPrimeLink",
  "AksomatiPrimeReceiver",
  "AkstilettoPrimeBarrel",
  "AkstilettoPrimeLink",
  "AkstilettoPrimeReceiver",
  "AlternoxPrimeBarrel",
  "AlternoxPrimeReceiver",
  "AlternoxPrimeStock",
  "AstillaPrimeBarrel",
  "AstillaPrimeReceiver",
  "AstillaPrimeStock",
  "BazaPrimeBarrel",
  "BazaPrimeReceiver",
  "BazaPrimeStock",
  "BoarPrimeBarrel",
  "BoarPrimeReceiver",
  "BoarPrimeStock",
  "BoltorPrimeBarrel",
  "BoltorPrimeReceiver",
  "BoltorPrimeStock",
  "BratonPrimeBarrel",
  "BratonPrimeReceiver",
  "BratonPrimeStock",
  "BurstonPrimeBarrel",
  "BurstonPrimeReceiver",
  "BurstonPrimeStock",
  "CedoPrimeBarrel",
  "CedoPrimeReceiver",
  "CedoPrimeStock",
];

function inventory() {
  return {
    Suits: [],
    MiscItems: PARTS.map((part) => ({ ItemType: PART_PREFIX + part, ItemCount: 2 })),
  };
}

interface Reachability {
  scrolled: number;
  buttonTop: number;
  buttonBottom: number;
  viewportHeight: number;
  panelTop: number;
  stickyBottom: number;
  /** Whether hit-testing the button centre lands on the button itself. */
  hitsButton: boolean;
}

async function measure(page: Page): Promise<Reachability> {
  return page.evaluate(() => {
    const content = document.querySelector("#content") as HTMLElement;
    const sticky = document.querySelector(".view-sticky-filters") as HTMLElement;
    const panel = document.querySelector("[data-orderbook-panel]") as HTMLElement;
    const button = document.querySelector("[data-orderbook-wfm]") as HTMLElement;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      scrolled: Math.round(content.scrollTop),
      buttonTop: Math.round(rect.top),
      buttonBottom: Math.round(rect.bottom),
      viewportHeight: window.innerHeight,
      panelTop: Math.round(panel.getBoundingClientRect().top),
      stickyBottom: Math.round(sticky.getBoundingClientRect().bottom),
      hitsButton: button === hit || button.contains(hit),
    };
  });
}

// Issue #29: the panel is sticky in the same scroll container as the filter
// band, which is opaque and paints above it. Pinned at the scrollport top, its
// whole action row lands under the band and out of reach of a click.
test.describe("Inventory order book stays reachable while scrolled", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-orderbook-reach-", { inventory: inventory() });
    page = harness.page;
    await openView(page, "inventory");
    await page.locator('[data-tour-tab="all_parts"]').click();
    await expect(page.locator(".item-card").first()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Never click a listing row here: Whisper and Profile reach the clipboard and
  // the system browser.
  async function resetPanel(): Promise<void> {
    const close = page.locator("[data-orderbook-close]");
    if ((await close.count()) > 0) await close.click();
    await expect(page.locator("[data-orderbook-panel]")).toHaveCount(0);
    await page.locator("#content").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForTimeout(200);
  }

  async function openPanelDeepInTheList(): Promise<void> {
    const cards = page.locator(".item-card");
    await expect.poll(async () => cards.count(), { timeout: 30_000 }).toBeGreaterThan(24);
    // Playwright scrolls the target into view, which leaves the grid deep in
    // the list exactly the way the report describes.
    await cards.nth(24).click();
    await expect(page.locator("[data-orderbook-wfm]")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
  }

  test("the warframe.market action clears the sticky filter band on a wide window", async () => {
    await setLayoutViewport(page, 1280, 700);
    await resetPanel();
    await openPanelDeepInTheList();

    const probe = await measure(page);
    expect(probe.scrolled).toBeGreaterThan(150);
    // A one-pixel tolerance: the band and the panel are laid out on fractional
    // device pixels and the rounding can put them a hair apart either way.
    expect(probe.panelTop).toBeGreaterThanOrEqual(probe.stickyBottom - 1);
    expect(probe.buttonTop).toBeGreaterThanOrEqual(probe.stickyBottom - 1);
    expect(probe.buttonBottom).toBeLessThanOrEqual(probe.viewportHeight);
    expect(probe.hitsButton).toBe(true);
    await expect(page.locator("[data-orderbook-wfm]")).toBeInViewport();
  });

  test("the action stays reachable on a window narrow enough to float the panel", async () => {
    await setLayoutViewport(page, 1000, 640);
    await resetPanel();
    await openPanelDeepInTheList();

    const probe = await measure(page);
    expect(probe.scrolled).toBeGreaterThan(150);
    expect(probe.buttonTop).toBeGreaterThanOrEqual(0);
    expect(probe.buttonBottom).toBeLessThanOrEqual(probe.viewportHeight);
    expect(probe.hitsButton).toBe(true);
  });
});
