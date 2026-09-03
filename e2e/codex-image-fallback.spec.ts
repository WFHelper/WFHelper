import fs from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

test.describe("Codex artwork fallback", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-codex-art-");
    page = harness.page;
    fs.writeFileSync(
      path.join(harness.sandboxDir, "user-data", "codex-scans.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        scans: [{ type: "/Lotus/Types/Enemies/Grineer/AIWeek/BladeSawmanAvatar", count: 20 }],
      }),
    );
    // The icon mirror answers an undeployed path with its own index page, so a
    // card gets HTTP 200 and a body no decoder accepts.
    await page.route("**/assets.wfhelper.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html></html>",
      }),
    );
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("a card whose artwork will not decode falls back to its initial", async () => {
    await page.locator('#sidebar [data-view="mastery"]').click();
    await page.locator('#content .view.active [data-tour-tab="codex"]').click();
    await expect(page.locator('[data-tour="mastery-codex-list"]')).toBeVisible({ timeout: 60_000 });

    // Only cards in the viewport: a lazy image that never scrolled into view has
    // neither loaded nor errored, so it is not evidence either way.
    const brokenInView = async (): Promise<number> =>
      page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll('[data-tour="mastery-codex-list"] [data-codex-entry]'),
          )
            .filter((card) => {
              const box = card.getBoundingClientRect();
              return box.top < window.innerHeight && box.bottom > 0;
            })
            .filter((card) => {
              const img = card.querySelector("img");
              return img instanceof HTMLImageElement && img.complete && !img.naturalWidth;
            }).length,
      );

    await expect.poll(brokenInView, { timeout: 30_000 }).toBe(0);
    const letters = await page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll('[data-tour="mastery-codex-list"] [data-codex-entry]'),
        ).filter((card) => !card.querySelector("img")).length,
    );
    expect(letters).toBeGreaterThan(0);
  });
});
