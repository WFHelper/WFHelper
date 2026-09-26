import { expect, test } from "@playwright/test";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  openView,
  setLayoutViewport,
  type ElectronTestHarness,
} from "./electronTestHarness";

const SCULPTURES = [
  ["ayatan_piv_sculpture", "Ayatan Piv Sculpture", "/Lotus/Types/Items/FusionTreasures/OroFusexE"],
  [
    "ayatan_anasa_sculpture",
    "Ayatan Anasa Sculpture",
    "/Lotus/Types/Items/FusionTreasures/OroFusexF",
  ],
  ["ayatan_ayr_sculpture", "Ayatan Ayr Sculpture", "/Lotus/Types/Items/FusionTreasures/OroFusexB"],
] as const;

// Never click Copy whisper or a seller name here: they reach the real clipboard
// and the default browser.
test("Ayatan sculptures list endo per plat across every sculpture and per order", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-ayatan-endo-");
    const { app, page } = harness;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const full = { amberStars: 1, cyanStars: 2 };
      const books: Record<string, unknown[]> = {
        ayatan_piv_sculpture: [
          {
            type: "sell",
            platinum: 4,
            quantity: 1,
            ...full,
            user: { ingameName: "PivFull", status: "ingame" },
          },
          {
            type: "sell",
            platinum: 2,
            quantity: 3,
            user: { ingameName: "PivEmpty", status: "ingame" },
          },
          {
            type: "sell",
            platinum: 3,
            quantity: 1,
            ...full,
            user: { ingameName: "PivOnline", status: "online" },
          },
          {
            type: "sell",
            platinum: 60,
            quantity: 12,
            perTrade: 6,
            ...full,
            user: { ingameName: "PivBulk", status: "ingame" },
          },
          {
            type: "buy",
            platinum: 3,
            quantity: 1,
            ...full,
            user: { ingameName: "PivBuyer", status: "ingame" },
          },
        ],
        ayatan_anasa_sculpture: [
          {
            type: "sell",
            platinum: 7,
            quantity: 1,
            amberStars: 2,
            cyanStars: 2,
            user: { ingameName: "AnasaFull", status: "ingame" },
          },
          {
            type: "sell",
            platinum: 5,
            quantity: 1,
            amberStars: 2,
            cyanStars: 2,
            user: { ingameName: "AnasaAway", status: "offline" },
          },
        ],
        ayatan_ayr_sculpture: [
          {
            type: "sell",
            platinum: 5,
            quantity: 1,
            amberStars: 0,
            cyanStars: 3,
            user: { ingameName: "AyrFull", status: "ingame" },
          },
        ],
      };
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith("https://api.warframe.market/")) return originalFetch(input, init);
        const orders = /\/v2\/orders\/item\/([a-z0-9_]+)/.exec(url);
        if (orders && (window as Window & { ayatanOffline?: boolean }).ayatanOffline) {
          return new Response("", { status: 503 });
        }
        const data = orders ? (books[orders[1]] ?? []) : { tradingTax: 4000 };
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
    });
    await evaluateInMain(
      app,
      ({ ipcMain }, sculptures) => {
        ipcMain.removeHandler("get-wfm-items");
        ipcMain.handle("get-wfm-items", () =>
          Object.fromEntries(
            sculptures.map(([slug, name, gameRef]) => [
              name.toLowerCase(),
              { url_name: slug, item_name: name, gameRef, thumb: null },
            ]),
          ),
        );
      },
      SCULPTURES,
    );
    await page.reload();
    await setLayoutViewport(page, 1280, 900);
    await openView(page, "market");
    await page.locator('[data-tour-tab="browse"]').click();
    const browse = page.locator('[data-tour="market-browse"]');

    await browse.locator("[data-browse-ayatan-preset]").click();
    await expect(browse.locator("[data-browse-ayatan-preset]")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const view = browse.locator("[data-ayatan-endo-browse]");
    const rows = view.locator("[data-ayatan-row]");
    const endoPerPlat = () =>
      rows.evaluateAll((els) =>
        els.map((el) =>
          el
            .querySelector("[data-ayatan-endo-per-plat]")
            ?.getAttribute("data-ayatan-endo-per-plat"),
        ),
      );

    // In-game sellers only by default; a 60p bulk trade of six Pivs is 10p each.
    await expect(rows).toHaveCount(5);
    expect(await endoPerPlat()).toEqual(["493", "431", "285", "188", "173"]);
    expect(
      await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-ayatan-slug"))),
    ).toEqual([
      "ayatan_anasa_sculpture",
      "ayatan_piv_sculpture",
      "ayatan_ayr_sculpture",
      "ayatan_piv_sculpture",
      "ayatan_piv_sculpture",
    ]);
    await expect(view.locator("[data-ayatan-best]")).toHaveAttribute("data-ayatan-best", "493");
    await expect(view.locator("[data-ayatan-order-count]")).toHaveAttribute(
      "data-ayatan-order-count",
      "5",
    );
    await expect(view.locator("[data-ayatan-updated]")).not.toHaveAttribute(
      "data-ayatan-updated",
      "",
    );
    await expect(view.locator("[data-ayatan-notice]")).toHaveCount(0);
    await page.screenshot({ path: "test-results/market-ayatan-endo-header.png" });

    await view.locator("[data-ayatan-min-endo]").fill("400");
    await expect(rows).toHaveCount(2);
    expect(await endoPerPlat()).toEqual(["493", "431"]);

    await view.locator('[data-ayatan-status="all"]').click();
    await expect(rows).toHaveCount(4);
    expect(await endoPerPlat()).toEqual(["690", "575", "493", "431"]);
    await page.screenshot({ path: "test-results/market-ayatan-endo-all.png" });

    const column = (key: string) => view.locator(`[data-ayatan-column="${key}"]`);
    await view.locator('[data-ayatan-sort="unitPrice"]').click();
    await expect(column("unitPrice")).toHaveAttribute("aria-sort", "ascending");
    await expect(column("endoPerPlat")).toHaveAttribute("aria-sort", "none");
    await expect.poll(endoPerPlat).toEqual(["575", "431", "690", "493"]);
    await view.locator('[data-ayatan-sort="unitPrice"]').click();
    await expect(column("unitPrice")).toHaveAttribute("aria-sort", "descending");
    await expect.poll(endoPerPlat).toEqual(["493", "690", "431", "575"]);

    await view.locator("[data-ayatan-min-endo]").fill("");
    await expect(rows).toHaveCount(7);
    await view.locator("[data-ayatan-sculpture-filter]").click();
    const menu = view.locator("[data-ayatan-sculpture-menu]");
    await menu.locator('[data-ayatan-sculpture-option="ayatan_piv_sculpture"]').check();
    await menu.locator('[data-ayatan-sculpture-option="ayatan_ayr_sculpture"]').check();
    await expect(menu.locator('[data-ayatan-sculpture-option="all"]')).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    expect(await endoPerPlat()).toEqual(["173", "285", "431", "575", "188"]);

    await view.locator('[data-ayatan-stars-filter="none"]').click();
    await expect(rows).toHaveCount(1);
    expect(await endoPerPlat()).toEqual(["188"]);
    await view.locator('[data-ayatan-stars-filter="full"]').click();
    await expect(rows).toHaveCount(4);
    expect(await endoPerPlat()).toEqual(["173", "285", "431", "575"]);
    await page.screenshot({ path: "test-results/market-ayatan-endo-sorted.png" });

    await rows.first().locator('[data-ayatan-open="ayatan_piv_sculpture"]').click();
    await expect(view).toHaveCount(0);
    await expect(browse.locator("[data-browse-ayatan-preset]")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const pivRow = (user: string) =>
      browse.locator("tbody tr", { hasText: user }).locator("[data-browse-endo-per-plat]");
    await expect(pivRow("PivFull")).toHaveAttribute("data-browse-endo-per-plat", "431");
    await expect(pivRow("PivEmpty")).toHaveAttribute("data-browse-endo-per-plat", "188");
    await expect(pivRow("PivBulk")).toHaveAttribute("data-browse-endo-per-plat", "173");
    await expect(pivRow("PivFull")).toContainText("1,725");
    await browse.locator(".browse-side-buy").click();
    await expect(pivRow("PivBuyer")).toHaveAttribute("data-browse-endo-per-plat", "575");
    await page.screenshot({ path: "test-results/market-ayatan-endo-piv.png" });

    // The sort and filters come back when the view opens again.
    await browse.locator("[data-browse-ayatan-preset]").click();
    await expect(rows).toHaveCount(4);
    await expect(column("unitPrice")).toHaveAttribute("aria-sort", "descending");
    await expect(view.locator('[data-ayatan-stars-filter="full"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await endoPerPlat()).toEqual(["173", "285", "431", "575"]);

    // A refresh that fails everywhere keeps the last orders and says how old they are.
    const setOffline = (offline: boolean) =>
      page.evaluate((value) => {
        (window as Window & { ayatanOffline?: boolean }).ayatanOffline = value;
      }, offline);
    const notice = view.locator("[data-ayatan-notice]");
    await setOffline(true);
    await view.locator("[data-ayatan-refresh]").click();
    await expect(notice).toHaveAttribute("data-ayatan-notice", "browse.ayatan.refreshFailed");
    await expect(rows).toHaveCount(4);
    expect(await endoPerPlat()).toEqual(["173", "285", "431", "575"]);
    await page.screenshot({ path: "test-results/market-ayatan-endo-refresh-failed.png" });
    await setOffline(false);
    await view.locator("[data-ayatan-refresh]").click();
    await expect(notice).toHaveCount(0);
    await expect(rows).toHaveCount(4);
    expect(errors).toEqual([]);
  } catch (error) {
    if (harness) {
      await harness.page.screenshot({ path: "test-results/market-ayatan-endo-failure.png" });
    }
    throw error;
  } finally {
    await closeElectronTestHarness(harness);
  }
});
