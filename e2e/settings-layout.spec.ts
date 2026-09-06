import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Screenshots belong in Playwright's per-test output dir so the CI artifact
// upload picks them up and no machine-specific path is baked in.
function shotPath(name: string): string {
  return test.info().outputPath(name);
}

// A fresh sandbox has no supporters cache, so the panel would only appear if a
// live backend answered in time. Seeding the cache makes the layout
// deterministic; loadSupporters() returns a fresh cache without fetching.
const SUPPORTERS_CACHE = JSON.stringify({
  cachedAt: Date.now(),
  supporters: [
    { name: "Fixture Patron One", tier: "biggest" },
    { name: "Fixture Patron Two", tier: "big" },
    { name: "Fixture Patron Three", tier: "basic" },
    { name: "Fixture Patron Four", tier: "basic" },
  ],
});

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

async function openSettings(page: Page, width: number, forcedColumn?: number): Promise<void> {
  await setLayoutViewport(page, width, 900);
  await openView(page, "settings");
  await expect(page.locator(".settings-control-row").first()).toBeVisible();
  // The masonry floor is 320px today; force it lower to exercise the degradation.
  await page.evaluate((column) => {
    for (const grid of Array.from(document.querySelectorAll<HTMLElement>(".settings-masonry"))) {
      grid.style.columns = column ? `${column}px` : "";
    }
  }, forcedColumn);
}

async function setFontScale(page: Page, scale: number | null): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) localStorage.removeItem("wf_theme_settings");
    else
      localStorage.setItem(
        "wf_theme_settings",
        JSON.stringify({ version: 1, fontSizes: { globalScale: value } }),
      );
  }, scale);
  await page.reload();
  await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
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
      await openSettings(page, width);
      const layout = await measureSettingsRows(page);
      await page.screenshot({ path: shotPath(`settings-${width}.png`) });

      expect(layout.count, `no settings rows rendered at ${width}px`).toBeGreaterThan(5);
      expect(layout.overlapping, `label and control overlap at ${width}px`).toEqual([]);
      expect(layout.overflowing, `row overflows its card at ${width}px`).toEqual([]);
      expect(layout.collapsed, `control squeezed away at ${width}px`).toEqual([]);
      expect(layout.shrinkable, `control may be squeezed at ${width}px`).toEqual([]);
    }

    await setFontScale(page, null);
  });

  test("a settings column narrower than the masonry floor stacks the control", async () => {
    await setFontScale(page, 1.25);
    await openSettings(page, 1240, 240);
    const layout = await measureSettingsRows(page);
    await page.screenshot({ path: shotPath("settings-narrow-column.png") });

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

  test("the supporters panel keeps its gap to the card above it", async () => {
    await openSettings(page, 1240);
    const panel = page.locator("[data-supporters]");
    await expect(panel, "seeded supporters cache did not render the panel").toBeVisible();

    const measured = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-supporters]");
      if (!el) return null;
      const style = getComputedStyle(el);
      const panelTop = el.getBoundingClientRect().top;
      let closest = -Infinity;
      for (const card of Array.from(
        document.querySelectorAll<HTMLElement>(".settings-masonry article"),
      )) {
        const bottom = card.getBoundingClientRect().bottom;
        if (bottom <= panelTop + 1) closest = Math.max(closest, bottom);
      }
      return {
        position: style.position,
        marginTop: parseFloat(style.marginTop),
        gap: closest === -Infinity ? null : panelTop - closest,
      };
    });
    await page.screenshot({ path: shotPath("settings-supporters.png") });

    expect(measured, "supporters panel disappeared mid-measurement").not.toBeNull();
    // The floated wide-container variant anchors with `top`, not `margin-top`.
    expect(measured!.position, "supporters panel is not in flow at 1240px").toBe("static");
    expect(measured!.gap, "no card sits above the supporters panel").not.toBeNull();
    expect(measured!.gap!, "supporters panel touches the card above it").toBeGreaterThanOrEqual(
      measured!.marginTop - 1,
    );
  });

  // The About rows are a label beside a link, and the narrowest masonry column
  // lands around 1040px. Each row keeps label and link on one line or stacks
  // them, never splitting into two ragged columns. A raised font scale is what
  // makes the row narrow enough for the difference to show.
  test("Settings About and Supporters cards stay readable when the window narrows", async () => {
    await setFontScale(page, 1.25);

    for (const width of [700, 900, 1040, 1200]) {
      await openSettings(page, width);
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
        const actions = document.querySelector<HTMLElement>("[data-settings-actions]");
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
          actionsFit: actions ? actions.scrollWidth <= actions.clientWidth + 1 : false,
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
      expect(layout.actionsFit, `settings actions overflow at ${width}px`).toBe(true);
      expect(layout.contentFits, `settings scrolls sideways at ${width}px`).toBe(true);
    }

    await setFontScale(page, null);
  });
});
