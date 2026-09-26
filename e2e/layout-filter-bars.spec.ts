import { expect, test, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  LAYOUT_SCALES,
  LAYOUT_SIZES,
  openView,
  setFontScale,
  setWindowSize,
  type ElectronTestHarness,
} from "./electronTestHarness";

interface Layout {
  width: number;
  height: number;
  scale: number;
}

const PART_PREFIX = "/Lotus/Types/Recipes/Weapons/WeaponParts/";
const PARTS = [
  "AcceltraPrimeBarrel",
  "AcceltraPrimeReceiver",
  "AcceltraPrimeStock",
  "BratonPrimeBarrel",
  "BratonPrimeReceiver",
  "BratonPrimeStock",
];
const RIVEN_TYPE = "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare";

const inventory = {
  Suits: [],
  MiscItems: PARTS.map((part) => ({ ItemType: PART_PREFIX + part, ItemCount: 2 })),
  Upgrades: [
    {
      ItemId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbb0" },
      ItemType: RIVEN_TYPE,
      UpgradeFingerprint: JSON.stringify({
        compat: "/Lotus/Weapons/Tenno/Rifle/Rifle",
        lvl: 8,
        lvlReq: 9,
        pol: "AP_ATTACK",
        buffs: [
          { Tag: "WeaponCritChanceMod", Value: 600_000_000 },
          { Tag: "WeaponFireDamageMod", Value: 700_000_000 },
        ],
        curses: [],
      }),
    },
    {
      // A challenge fingerprint with no compat is what files a riven as veiled.
      ItemId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbb1" },
      ItemType: RIVEN_TYPE,
      UpgradeFingerprint: JSON.stringify({
        challenge: { Type: "/Lotus/Types/Challenges/RandomizedKill", Progress: 20, Required: 50 },
      }),
    },
    {
      ItemId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbb2" },
      ItemType: RIVEN_TYPE,
      UpgradeFingerprint: JSON.stringify({
        challenge: { Type: "/Lotus/Types/Challenges/RandomizedFisherman", Required: 5 },
      }),
    },
    {
      ItemId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbb3" },
      ItemType: RIVEN_TYPE,
      UpgradeFingerprint: JSON.stringify({
        challenge: {
          Type: "/Lotus/Types/Challenges/DJRandomizedKill",
          Progress: 4,
          Required: 120,
          Complication: "/Lotus/Types/Challenges/Complications/ResetOnDowned",
        },
      }),
    },
    {
      ItemId: { $oid: "bbbbbbbbbbbbbbbbbbbbbbb4" },
      ItemType: RIVEN_TYPE,
      UpgradeFingerprint: JSON.stringify({}),
    },
  ],
};

async function forEachLayout(
  harness: ElectronTestHarness,
  run: (layout: Layout) => Promise<void>,
): Promise<void> {
  for (const scale of [1, ...LAYOUT_SCALES]) {
    await setFontScale(harness.page, scale);
    for (const size of LAYOUT_SIZES) {
      await setWindowSize(harness, size.width, size.height);
      await run({ ...size, scale });
    }
  }
}

function measureInlineBar(page: Page, barSelector: string, edgeSelector: string) {
  return page.evaluate(
    ({ bar, edge }) => {
      const controls = document.querySelector<HTMLElement>(`${bar} .shared-filter-controls`);
      const reachable = document.querySelector<HTMLElement>(edge);
      if (!controls || !reachable) throw new Error(`inline filter bar ${bar} is missing`);
      const rect = reachable.getBoundingClientRect();
      return {
        hiddenWidth: controls.scrollWidth - controls.clientWidth,
        outsideWindow: Math.max(
          rect.right - window.innerWidth,
          rect.bottom - window.innerHeight,
          -rect.left,
          -rect.top,
        ),
      };
    },
    { bar: barSelector, edge: edgeSelector },
  );
}

function measureRelicSelects(page: Page) {
  return page.evaluate(() => {
    const selects = Array.from(
      document.querySelectorAll<HTMLSelectElement>(
        "[data-relic-filter-controls] label.shared-filter-sort select.shared-filter-select, " +
          "[data-relic-filter-controls] .sort-control select.sort-control-select",
      ),
    );
    if (selects.length === 0) throw new Error("relic filter selects are missing");
    return selects.map((select, index) => {
      // A select clips its value without an ellipsis and never reports a
      // scrollWidth for it, so compare against a content-sized copy of itself.
      const probe = select.cloneNode(true) as HTMLSelectElement;
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.width = "auto";
      probe.style.minWidth = "0";
      probe.style.maxWidth = "none";
      (select.parentElement ?? document.body).append(probe);
      const natural = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        index,
        clipped: natural - select.getBoundingClientRect().width,
        hiddenWidth: select.scrollWidth - select.clientWidth,
      };
    });
  });
}

function measureVeiledRow(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("[data-riven-veiled-row]");
    const name = row?.querySelector<HTMLElement>("[data-riven-veiled-name]");
    const challenge = row?.querySelector<HTMLElement>("[data-riven-veiled-challenge]");
    if (!name || !challenge) throw new Error("veiled riven row is missing");
    return challenge.getBoundingClientRect().left - name.getBoundingClientRect().right;
  });
}

function measureFoundryEmpty(page: Page) {
  return page.evaluate(() => {
    const text = document.querySelector<HTMLElement>("[data-foundry-empty] p");
    const content = document.querySelector<HTMLElement>("#content");
    if (!text || !content) throw new Error("foundry empty state is missing");
    const top = text.getBoundingClientRect().top;
    return {
      belowWindow: top - window.innerHeight,
      belowScrollport: top - content.getBoundingClientRect().bottom,
      scrolled: content.scrollTop,
    };
  });
}

test.describe("Filter bars keep their controls at a raised text scale", () => {
  test.setTimeout(300_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-layout-filter-bars-", { inventory });
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("the rivens filter bar shows every control it holds", async () => {
    await forEachLayout(harness, async (layout) => {
      const at = `${layout.width}x${layout.height} at ${layout.scale}x`;
      await openView(page, "rivens");
      await page.locator('[data-tour="riven-view-tabs"] [data-tour-tab="unveiled"]').click();
      const bar = page.locator('.shared-filter-bar-inline[data-tour="filter-bar"]');
      await expect(bar).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-filter-customize-toggle="rivens"]')).toBeVisible();

      const box = await measureInlineBar(
        page,
        '.shared-filter-bar-inline[data-tour="filter-bar"]',
        '[data-filter-customize-toggle="rivens"]',
      );
      await bar.screenshot({
        path: test.info().outputPath(`rivens-bar-${layout.width}-${layout.scale}.png`),
      });

      expect(box.hiddenWidth, `riven filter controls hide content at ${at}`).toBeLessThanOrEqual(1);
      expect(box.outsideWindow, `riven customize toggle leaves the window at ${at}`).toBeLessThan(
        0.5,
      );
    });
  });

  test("the veiled riven row keeps a gap between name and challenge", async () => {
    await forEachLayout(harness, async (layout) => {
      const at = `${layout.width}x${layout.height} at ${layout.scale}x`;
      await openView(page, "rivens");
      await page.locator('[data-tour="riven-view-tabs"] [data-tour-tab="veiled"]').click();
      await expect(page.locator("[data-riven-veiled-row]").first()).toBeVisible({
        timeout: 30_000,
      });

      const gap = await measureVeiledRow(page);
      expect(gap, `veiled mod name and challenge sit flush at ${at}`).toBeGreaterThan(2);
    });
  });

  test("the veiled tab groups rivens that share a challenge", async () => {
    await openView(page, "rivens");
    await page.locator('[data-tour="riven-view-tabs"] [data-tour-tab="veiled"]').click();
    const groups = page.locator("[data-riven-veiled-group]");
    await expect(groups).toHaveCount(3, { timeout: 30_000 });

    const summary = await groups.evaluateAll((sections) =>
      sections.map((section) => ({
        label: section.getAttribute("data-riven-veiled-group"),
        count: section.querySelector("[data-riven-veiled-group-count]")?.textContent?.trim(),
        rows: section.querySelectorAll("[data-riven-veiled-row]").length,
      })),
    );
    expect(summary).toEqual([
      { label: "Kill Enemies", count: "x2", rows: 2 },
      { label: "Catch fish without missing a throw", count: "x1", rows: 1 },
      { label: "Challenge not yet assigned", count: "x1", rows: 1 },
    ]);
    await expect(groups.first().locator("[data-riven-veiled-challenge]")).toHaveText([
      /Kill 50 Enemies/,
      /Kill 120 Enemies without dying or becoming downed/,
    ]);
    await page.screenshot({ path: test.info().outputPath("rivens-veiled-groups.png") });
  });

  test("the relic filter selects show their whole value", async () => {
    await forEachLayout(harness, async (layout) => {
      const at = `${layout.width}x${layout.height} at ${layout.scale}x`;
      await openView(page, "relics");
      await expect(page.locator("[data-relic-filter-controls]")).toBeVisible({ timeout: 30_000 });

      const selects = await measureRelicSelects(page);
      expect(selects.length, `relic filter selects are missing at ${at}`).toBeGreaterThanOrEqual(4);
      for (const select of selects) {
        expect(
          select.clipped,
          `relic select ${select.index} clips its value at ${at}`,
        ).toBeLessThan(1);
        expect(
          select.hiddenWidth,
          `relic select ${select.index} hides content at ${at}`,
        ).toBeLessThanOrEqual(1);
      }
    });
  });

  test("the inventory toolbar keeps its buttons whole", async () => {
    await forEachLayout(harness, async (layout) => {
      const at = `${layout.width}x${layout.height} at ${layout.scale}x`;
      for (const tab of ["all_parts", "full_sets"]) {
        await openView(page, "inventory");
        await page.locator(`[data-tour-tab="${tab}"]`).click();
        await expect(page.locator(".view-sticky-filters .shared-filter-bar-inline")).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.locator("[data-advanced-filters-toggle]")).toBeVisible();

        const box = await measureInlineBar(
          page,
          ".view-sticky-filters .shared-filter-bar-inline",
          "[data-advanced-filters-toggle]",
        );
        await page.locator(".view-sticky-filters").screenshot({
          path: test.info().outputPath(`inventory-${tab}-${layout.width}-${layout.scale}.png`),
        });

        expect(box.hiddenWidth, `${tab} toolbar hides content at ${at}`).toBeLessThanOrEqual(1);
        expect(
          box.outsideWindow,
          `${tab} advanced-filter button leaves the window at ${at}`,
        ).toBeLessThan(0.5);
      }
    });
  });

  test("an empty foundry category shows its message in view", async () => {
    await forEachLayout(harness, async (layout) => {
      const at = `${layout.width}x${layout.height} at ${layout.scale}x`;
      await openView(page, "foundry");
      await page.locator('[data-tour-tab="cat:Misc"]').click();
      await expect(page.locator("[data-foundry-empty]")).toBeVisible({ timeout: 30_000 });

      const box = await measureFoundryEmpty(page);
      await page.screenshot({
        animations: "disabled",
        path: test.info().outputPath(`foundry-empty-${layout.width}-${layout.scale}.png`),
      });

      expect(box.scrolled, `the foundry view was scrolled before measuring at ${at}`).toBe(0);
      expect(box.belowWindow, `the empty message starts below the window at ${at}`).toBeLessThan(0);
      expect(
        box.belowScrollport,
        `the empty message starts below the content area at ${at}`,
      ).toBeLessThan(0);
    });
  });
});
