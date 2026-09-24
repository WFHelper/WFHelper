import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setFontScale,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Screenshots belong in Playwright's per-test output dir so the CI artifact
// upload picks them up and no machine-specific path is baked in.
function shotPath(name: string): string {
  return test.info().outputPath(name);
}

// The panel only renders with a supporters cache; seeding one keeps the layout
// deterministic since loadSupporters() then returns it without fetching.
const SUPPORTERS_CACHE = JSON.stringify({
  cachedAt: Date.now(),
  supporters: [
    { name: "Fixture Patron One", tier: "biggest" },
    { name: "Fixture Patron Two", tier: "big" },
    { name: "Fixture Patron Three", tier: "basic" },
    { name: "Fixture Patron Four", tier: "basic" },
  ],
});

const ROW_CATEGORIES = ["general", "notifications", "inventory", "overlay", "appearance"] as const;
type Category = (typeof ROW_CATEGORIES)[number] | "about";
const APPEARANCE_TABS = ["theme", "colors", "overlays", "sidebar", "css"] as const;
type AppearanceTab = (typeof APPEARANCE_TABS)[number];

/**
 * Label beside control, both measured. A wrapped control shares no line with its
 * label, so `stacked` and `overlaps` are the two ways a row can end up.
 */
async function measureSettingsRows(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".settings-control-row"));
    const measured = rows
      .map((row) => {
        const kids = Array.from(row.children) as HTMLElement[];
        if (kids.length < 2) return null;
        const controlEl = kids[kids.length - 1]!;
        const label = kids[0]!.getBoundingClientRect();
        const control = controlEl.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const rowStyle = getComputedStyle(row);
        const contentLeft =
          rowRect.left + parseFloat(rowStyle.borderLeftWidth) + parseFloat(rowStyle.paddingLeft);
        const contentRight =
          rowRect.right - parseFloat(rowStyle.borderRightWidth) - parseFloat(rowStyle.paddingRight);
        return {
          name: (kids[0]!.textContent ?? "").trim().slice(0, 40),
          overflows: row.scrollWidth > row.clientWidth + 1,
          overlaps:
            Math.min(label.right, control.right) - Math.max(label.left, control.left) > 0.5 &&
            Math.min(label.bottom, control.bottom) - Math.max(label.top, control.top) > 0.5,
          stacked: control.top >= label.bottom - 1,
          controlWidth: Math.round(control.width),
          // The rule that owns both lives in SettingsRow but styles a slot the
          // caller authored, so it is the one that silently stops matching.
          shrinks: getComputedStyle(controlEl).flexShrink !== "0",
          rightGap: contentRight - control.right,
          leftGap: control.left - contentLeft,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const stacked = measured.filter((entry) => entry.stacked);
    return {
      count: measured.length,
      overlapping: measured.filter((entry) => entry.overlaps).map((entry) => entry.name),
      overflowing: measured.filter((entry) => entry.overflows).map((entry) => entry.name),
      stacked: stacked.map((entry) => entry.name),
      // A control squeezed to nothing is the other half of the same defect.
      collapsed: measured.filter((entry) => entry.controlWidth < 8).map((entry) => entry.name),
      shrinkable: measured.filter((entry) => entry.shrinks).map((entry) => entry.name),
      notFlushRight: stacked.filter((entry) => entry.rightGap > 1).map((entry) => entry.name),
      // Without this a full-width control would satisfy notFlushRight for free.
      indentedStacked: stacked.filter((entry) => entry.leftGap > 1).length,
    };
  });
}

type RowLayout = Awaited<ReturnType<typeof measureSettingsRows>>;

function mergeLayouts(layouts: Array<[string, RowLayout]>): RowLayout {
  const tag = (category: string, names: string[]) => names.map((name) => `${category}: ${name}`);
  return {
    count: layouts.reduce((sum, [, layout]) => sum + layout.count, 0),
    overlapping: layouts.flatMap(([category, layout]) => tag(category, layout.overlapping)),
    overflowing: layouts.flatMap(([category, layout]) => tag(category, layout.overflowing)),
    stacked: layouts.flatMap(([category, layout]) => tag(category, layout.stacked)),
    collapsed: layouts.flatMap(([category, layout]) => tag(category, layout.collapsed)),
    shrinkable: layouts.flatMap(([category, layout]) => tag(category, layout.shrinkable)),
    notFlushRight: layouts.flatMap(([category, layout]) => tag(category, layout.notFlushRight)),
    indentedStacked: layouts.reduce((sum, [, layout]) => sum + layout.indentedStacked, 0),
  };
}

async function selectCategory(page: Page, category: Category): Promise<void> {
  const button = page.locator(`#content .view.active [data-tour-tab="${category}"]`);
  await button.click();
  await expect(button).toHaveAttribute("data-active", "true");
  await expect(page.locator(`[data-settings-panel="${category}"]`)).toBeVisible();
}

async function selectAppearanceTab(page: Page, tab: AppearanceTab): Promise<void> {
  const button = page.locator(`[data-appearance-tab="${tab}"]`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-appearance-panel="${tab}"]`)).toBeVisible();
}

async function forceColumns(page: Page, column?: number): Promise<void> {
  // The card floor is 320px today; force it lower to exercise the degradation.
  await page.evaluate((width) => {
    for (const grid of Array.from(document.querySelectorAll<HTMLElement>(".settings-masonry"))) {
      grid.style.columns = width ? `${width}px` : "";
    }
    for (const grid of Array.from(document.querySelectorAll<HTMLElement>(".settings-grid"))) {
      grid.style.gridTemplateColumns = width ? `repeat(auto-fill, ${width}px)` : "";
    }
  }, column);
}

async function openSettings(page: Page, width: number, category: Category): Promise<void> {
  await setLayoutViewport(page, width, 900);
  await openView(page, "settings");
  await selectCategory(page, category);
}

async function measureAllCategories(page: Page, forcedColumn?: number): Promise<RowLayout> {
  const layouts: Array<[string, RowLayout]> = [];
  for (const category of ROW_CATEGORIES) {
    await selectCategory(page, category);
    const tabs = category === "appearance" ? APPEARANCE_TABS : [null];
    for (const tab of tabs) {
      if (tab) await selectAppearanceTab(page, tab);
      await forceColumns(page, forcedColumn);
      layouts.push([tab ? `${category}/${tab}` : category, await measureSettingsRows(page)]);
    }
  }
  return mergeLayouts(layouts);
}

async function measureTabs(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector<HTMLElement>("#content .view.active")!;
    const tabs = view.querySelector<HTMLElement>('[data-tour="settings-tabs"]')!;
    const title = view.querySelector<HTMLElement>("h2")!;
    const panel = view.querySelector<HTMLElement>("[data-settings-panel]")!;
    const tabsRect = tabs.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const items = Array.from(tabs.querySelectorAll<HTMLElement>("button"));
    const content = document.querySelector<HTMLElement>("#content")!;
    return {
      itemCount: items.length,
      activeCount: items.filter((item) => item.dataset.active === "true").length,
      belowTitle: tabsRect.top >= titleRect.bottom - 1,
      aboveCards: tabsRect.bottom <= panelRect.top + 1,
      alignedWithTitle: Math.abs(tabsRect.left - titleRect.left) <= 1,
      spansPanel: Math.abs(tabsRect.width - panelRect.width) <= 1,
      tabsOverflow: tabs.scrollWidth > tabs.clientWidth + 1,
      itemsOutside: items
        .filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left < tabsRect.left - 1 || rect.right > tabsRect.right + 1;
        })
        .map((item) => item.dataset.tourTab ?? ""),
      contentFits: content.scrollWidth <= content.clientWidth,
    };
  });
}

// Top-level cards of the visible appearance sub-tab: the columns they fill and how
// far the rightmost one stops short of the panel edge.
async function measureAppearanceCards(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-appearance-panel]")!;
    const cards = Array.from(panel.querySelectorAll<HTMLElement>("article")).filter(
      (card) => card.parentElement?.closest("article") === null,
    );
    const panelRect = panel.getBoundingClientRect();
    const lefts = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)));
    const right = Math.max(...cards.map((card) => card.getBoundingClientRect().right));
    return { cards: cards.length, columns: lefts.size, rightGap: panelRect.right - right };
  });
}

test.describe("Settings rows degrade without colliding", () => {
  test.setTimeout(300_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-settings-layout-e2e-", {
      storage: { wf_supporters_cache: SUPPORTERS_CACHE },
    });
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("settings control rows never overlap their control at 125% font size", async () => {
    await setFontScale(page, 1.25);

    for (const width of [700, 900, 1100]) {
      await openSettings(page, width, "general");
      const actionsFit = await page
        .locator("[data-settings-actions]")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      await page.screenshot({ path: shotPath(`settings-${width}.png`) });
      const layout = await measureAllCategories(page);

      expect(layout.count, `no settings rows rendered at ${width}px`).toBeGreaterThan(40);
      expect(layout.overlapping, `label and control overlap at ${width}px`).toEqual([]);
      expect(layout.overflowing, `row overflows its card at ${width}px`).toEqual([]);
      expect(layout.collapsed, `control squeezed away at ${width}px`).toEqual([]);
      expect(layout.shrinkable, `control may be squeezed at ${width}px`).toEqual([]);
      expect(actionsFit, `settings actions overflow at ${width}px`).toBe(true);
    }

    await setFontScale(page, null);
  });

  test("a settings column narrower than the masonry floor stacks the control", async () => {
    await setFontScale(page, 1.25);
    await openSettings(page, 1240, "general");
    const layout = await measureAllCategories(page, 240);
    await selectCategory(page, "general");
    await forceColumns(page, 240);
    await page.screenshot({ path: shotPath("settings-narrow-column.png") });
    await forceColumns(page);

    expect(layout.overlapping, "label and control overlap in a narrow column").toEqual([]);
    expect(layout.overflowing, "row overflows a narrow column").toEqual([]);
    expect(layout.collapsed, "control squeezed away in a narrow column").toEqual([]);
    // Wrapping is the intended escape hatch, so at least one control must use it.
    expect(layout.stacked.length, "no control dropped below its label").toBeGreaterThan(0);
    // The two halves of the SettingsRow rule, measured instead of assumed:
    // flex-shrink from the computed style, margin-left from where it landed.
    expect(layout.shrinkable, "control may be squeezed in a narrow column").toEqual([]);
    expect(layout.notFlushRight, "stacked control not pushed to the row end").toEqual([]);
    expect(
      layout.indentedStacked,
      "every stacked control fills its row, so the end alignment proves nothing",
    ).toBeGreaterThan(0);

    await setFontScale(page, null);
  });

  test("the categories are header tabs under the title, wrapping when narrow", async () => {
    await setFontScale(page, 1.25);

    for (const width of [700, 900, 1100, 1240, 1920]) {
      await openSettings(page, width, "notifications");
      const tabs = await measureTabs(page);
      await page.screenshot({ path: shotPath(`settings-tabs-${width}.png`) });

      expect(tabs.itemCount, `category tabs missing at ${width}px`).toBe(6);
      expect(tabs.activeCount, `not exactly one active tab at ${width}px`).toBe(1);
      expect(tabs.belowTitle, `tabs not under the title at ${width}px`).toBe(true);
      expect(tabs.aboveCards, `tabs not above the cards at ${width}px`).toBe(true);
      expect(tabs.alignedWithTitle, `tabs not aligned with the title at ${width}px`).toBe(true);
      expect(tabs.spansPanel, `tab row narrower than the cards at ${width}px`).toBe(true);
      expect(tabs.contentFits, `settings scrolls sideways at ${width}px`).toBe(true);
      expect(tabs.tabsOverflow, `category tabs overflow at ${width}px`).toBe(false);
      expect(tabs.itemsOutside, `category tab clipped at ${width}px`).toEqual([]);
    }

    await setFontScale(page, null);
  });

  test("appearance sub-tabs spread their cards across a wide window", async () => {
    await openSettings(page, 1920, "appearance");
    for (const tab of APPEARANCE_TABS) {
      await selectAppearanceTab(page, tab);
      const cards = await measureAppearanceCards(page);
      await page.screenshot({ path: shotPath(`settings-appearance-${tab}-1920.png`) });

      expect(cards.cards, `no cards on the ${tab} tab`).toBeGreaterThan(0);
      expect(cards.columns, `${tab} cards stacked in one column`).toBe(Math.min(cards.cards, 3));
      expect(cards.rightGap, `${tab} cards leave the right side empty`).toBeLessThan(2);
    }
  });

  test("categories and section info open from the keyboard", async () => {
    await openSettings(page, 1240, "general");
    const overlay = page.locator('#content .view.active [data-tour-tab="overlay"]');
    await overlay.focus();
    await page.keyboard.press("Enter");
    await expect(overlay).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-settings-panel="overlay"]')).toBeVisible();
    await expect(page.locator('#content [data-tour-tab="general"]')).not.toHaveAttribute(
      "data-active",
    );

    const toggle = page.locator("[data-settings-info-toggle]").first();
    const info = page.locator("[data-settings-info]").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(info).toBeHidden();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(info).toBeVisible();
    await page.screenshot({ path: shotPath("settings-info-open.png") });
    await page.keyboard.press("Enter");
    await expect(info).toBeHidden();
  });

  test("the supporters panel keeps its gap to the About card", async () => {
    await setFontScale(page, null);
    for (const width of [700, 1240, 1920]) {
      await openSettings(page, width, "about");
      const panel = page.locator("[data-supporters]");
      await expect(panel, "seeded supporters cache did not render the panel").toBeVisible();

      const measured = await page.evaluate(() => {
        const supporters = document.querySelector<HTMLElement>("[data-supporters]");
        const about = document.querySelector<HTMLElement>("[data-settings-panel] article");
        if (!supporters || !about) return null;
        const s = supporters.getBoundingClientRect();
        const a = about.getBoundingClientRect();
        return {
          beside: s.left >= a.right,
          sideGap: s.left - a.right,
          stackGap: s.top - a.bottom,
          topDelta: Math.abs(s.top - a.top),
          insideWindow: s.right <= innerWidth,
        };
      });
      await page.screenshot({ path: shotPath(`settings-supporters-${width}.png`) });

      expect(measured, "supporters panel disappeared mid-measurement").not.toBeNull();
      expect(measured!.insideWindow, `supporters leave the window at ${width}px`).toBe(true);
      if (width === 1920) {
        expect(measured!.beside, `supporters not beside About at ${width}px`).toBe(true);
      }
      if (measured!.beside) {
        expect(measured!.sideGap, `supporters touch the About card at ${width}px`).toBeGreaterThan(
          8,
        );
        expect(measured!.topDelta, `supporters not aligned at ${width}px`).toBeLessThan(2);
      } else {
        expect(measured!.stackGap, `supporters touch the About card at ${width}px`).toBeGreaterThan(
          8,
        );
      }
    }
  });

  // Each row keeps label and link on one line or fully stacks, and a raised font
  // scale is what forces it to show.
  test("Settings About and Supporters cards stay readable when the window narrows", async () => {
    await setFontScale(page, 1.25);

    for (const width of [700, 900, 1040, 1200]) {
      await openSettings(page, width, "about");
      await expect(page.locator(".settings-credit-row").first()).toBeVisible();
      await expect(page.locator("[data-supporters]")).toBeVisible();

      const layout = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(".settings-credit-row"));
        const label = (row: HTMLElement) => (row.firstElementChild as HTMLElement) ?? row;
        const value = (row: HTMLElement) => (row.lastElementChild as HTMLElement) ?? row;
        const name = (row: HTMLElement) => (label(row).textContent ?? "").trim();
        const linkHeights = Array.from(
          document.querySelectorAll<HTMLElement>(".settings-link"),
          (link) => link.getBoundingClientRect().height,
        );
        const supporters = document.querySelector<HTMLElement>("[data-supporters]");
        const supportersRect = supporters?.getBoundingClientRect() ?? null;
        const content = document.querySelector<HTMLElement>("#content")!;
        return {
          rowCount: rows.length,
          // Math.max of nothing is -Infinity, so an absent element has to be
          // reported rather than folded into a ratio that passes anything.
          linkCount: linkHeights.length,
          supporterChipCount: supporters
            ? supporters.querySelectorAll("span[class*='rounded-full']").length
            : 0,
          // Either the value sits beside the label or it wrapped underneath it.
          collisions: rows
            .filter((row) => {
              const l = label(row).getBoundingClientRect();
              const v = value(row).getBoundingClientRect();
              return v.left < l.right - 1 && v.top < l.bottom - 1;
            })
            .map(name),
          overflowing: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map(name),
          // A link broken across two lines is twice as tall as its siblings.
          linkHeightRatio: linkHeights.length
            ? Math.max(...linkHeights) / Math.min(...linkHeights)
            : null,
          chipsOutside: supporters
            ? Array.from(supporters.querySelectorAll<HTMLElement>("span[class*='rounded-full']"))
                .filter((chip) => chip.getBoundingClientRect().right > supportersRect!.right)
                .map((chip) => chip.textContent ?? "")
            : null,
          contentFits: content.scrollWidth <= content.clientWidth,
        };
      });

      expect(layout.rowCount, `no credit rows rendered at ${width}px`).toBeGreaterThan(0);
      expect(layout.linkCount, `no credit links rendered at ${width}px`).toBeGreaterThan(0);
      expect(layout.supporterChipCount, `no supporter chips at ${width}px`).toBeGreaterThan(0);
      expect(layout.collisions, `credit rows collide at ${width}px`).toEqual([]);
      expect(layout.overflowing, `credit rows overflow at ${width}px`).toEqual([]);
      expect(layout.linkHeightRatio!, `a credit link wraps at ${width}px`).toBeLessThan(1.6);
      expect(layout.chipsOutside, `supporter chips escape the card at ${width}px`).toEqual([]);
      expect(layout.contentFits, `settings scrolls sideways at ${width}px`).toBe(true);
    }

    await setFontScale(page, null);
  });

  // The async channel load must not repaint these checkboxes back to their default
  // when settings remounts, or a re-checked box would silently revert.
  test("notification channel boxes survive leaving settings", async () => {
    await openSettings(page, 1100, "notifications");
    const boxes = () =>
      page.locator('[data-setting="notify-source-worldState"] input[type="checkbox"]');
    await expect(boxes().first()).toBeVisible();
    await boxes().nth(1).check();
    await expect(boxes().nth(1)).toBeChecked();

    await openView(page, "inventory");
    await openView(page, "settings");

    await expect(page.locator('[data-settings-panel="notifications"]')).toBeVisible();
    await expect(boxes().nth(1)).toBeChecked();
    await expect(boxes().first()).toBeChecked();
  });
});
