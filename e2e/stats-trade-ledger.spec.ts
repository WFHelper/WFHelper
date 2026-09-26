import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { expect, test } from "@playwright/test";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

const LIVE_ROWS = 305;
const PAGE_ROWS = 300;

function trade(id: string, date: string, partner: string) {
  return {
    id,
    date,
    type: "sale",
    platChange: 10,
    partner,
    items: [
      {
        internalName: "/Lotus/Fixture",
        displayName: `Fixture ${id}`,
        count: 1,
        direction: "given",
      },
    ],
  };
}

function liveTrades(): unknown[] {
  const year = new Date().getFullYear();
  return Array.from({ length: LIVE_ROWS }, (_, index) => {
    const minute = String(index % 60).padStart(2, "0");
    const hour = String(Math.floor(index / 60)).padStart(2, "0");
    return trade(`live-${index}`, `${year}-01-02T${hour}:${minute}:00.000Z`, "LivePartner");
  });
}

test.describe("Stats trade list", () => {
  let harness: ElectronTestHarness;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-stats-ledger-", {
      userDataFiles: { "trade-log.json": liveTrades() },
    });
    // Archives are read on query, so a year written after launch is still picked up.
    const ledgerDir = path.join(harness.sandboxDir, "user-data", "trade-ledger");
    fs.mkdirSync(ledgerDir, { recursive: true });
    const archived = [
      trade("archived-2024-1", "2024-06-01T10:00:00.000Z", "ArchivePartner"),
      trade("archived-2024-2", "2024-03-01T10:00:00.000Z", "ArchivePartner"),
    ];
    fs.writeFileSync(
      path.join(ledgerDir, "2024.json.gz"),
      zlib.gzipSync(Buffer.from(JSON.stringify(archived))),
    );
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("pages archived trades and keeps live arrivals and updates during loading", async () => {
    const { page } = harness;
    await evaluateInMain(harness.app, ({ app, BrowserWindow }) => {
      const main = process.mainModule as unknown as {
        require: (path: string) => typeof import("../services/tradeLedgerStore");
      };
      const store = main.require(`${app.getAppPath()}/.electron-build/services/tradeLedgerStore`);
      const query = store.queryLedger;
      let pages = 0;
      store.queryLedger = (options, live) => {
        if (++pages !== 2) return query(options, live);
        store.queryLedger = query;
        const updated = { ...live.find((row) => row.id === "live-304")!, platChange: 77 };
        const arrival = { ...updated, id: "during-load", date: new Date().toISOString() };
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("trade-recorded", { trade: arrival });
          window.webContents.send("trade-recorded", { trade: updated });
        }
        return query(options, [arrival, ...live]);
      };
    });
    await page.locator('#sidebar [data-view="stats"]').click();
    const panel = page.locator("[data-stats-trade-panel]");
    await expect(panel.locator("[data-trade-row]")).toHaveCount(PAGE_ROWS, { timeout: 30_000 });
    const more = panel.locator("[data-stats-trades-more]");
    await expect(more).toHaveAttribute("data-stats-trades-more", String(LIVE_ROWS + 3 - PAGE_ROWS));
    await expect(panel.locator('[data-trade-row="during-load"]')).toHaveCount(1);
    await expect(panel.locator('[data-trade-row="live-304"]')).toContainText("77");
    await more.click();
    await expect(panel.locator("[data-trade-row]")).toHaveCount(LIVE_ROWS + 3);
    await expect(panel.locator('[data-trade-row="archived-2024-2"]')).toHaveCount(1);
    await expect(more).toHaveCount(0);

    await panel.locator("input[type='search'], input").first().fill("ArchivePartner");
    await expect(panel.locator("[data-trade-row]")).toHaveCount(2);
    await page.screenshot({
      path: test.info().outputPath("stats-trade-ledger.png"),
      animations: "disabled",
    });
  });
});
