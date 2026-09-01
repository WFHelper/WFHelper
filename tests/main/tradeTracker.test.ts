import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("electron", () => ({
  app: { getPath: () => tmpDir },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/statsTracker", () => ({ incrementTodayTrades: vi.fn() }));
vi.mock("../../services/wfmCatalog", () => ({ lookupByName: vi.fn(() => null) }));

type Tracker = typeof import("../../services/tradeTracker");

// Rows from a finished year rotate into the ledger archives on load, so these
// fixtures have to stay inside the current year to exercise the live log.
const YEAR = new Date().getUTCFullYear();

async function tracker(): Promise<Tracker> {
  const module = await import("../../services/tradeTracker");
  module.__resetTradeTrackerForTest();
  return module;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-test-"));
});

afterEach(async () => {
  (await import("../../services/tradeTracker")).__resetTradeTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tradeTracker", () => {
  it("drops malformed persisted entries", async () => {
    const module = await tracker();
    fs.writeFileSync(
      path.join(tmpDir, "trade-log.json"),
      JSON.stringify([
        null,
        { id: "bad", date: "nope", type: "sale", platChange: 10, items: [] },
        {
          id: "valid",
          date: `${YEAR}-07-18T10:00:00.000Z`,
          type: "sale",
          platChange: 10,
          items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
        },
      ]),
    );

    module.loadTradeLog();
    expect(module.getTradeLog()).toHaveLength(1);
    expect(module.getTradeLog()[0].id).toBe("valid");
  });

  it("rejects malformed imported entries without throwing", async () => {
    const module = await tracker();
    expect(module.importTradeLog([null, {}, { id: "partial" }])).toBe(0);
    expect(module.getTradeLog()).toEqual([]);
  });

  it("takes the good rows of a mixed import through the one sanitize pass", async () => {
    const module = await tracker();
    const good = {
      id: "import-1",
      date: `${YEAR}-07-18T10:00:00.000Z`,
      type: "sale",
      platChange: 12,
      partner: "Kestrel",
      items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
    };
    const rows = [null, good, { ...good, id: "negative", platChange: -5 }];
    expect(module.importTradeLog(rows)).toBe(1);
    expect(module.getTradeLog().map((e) => e.id)).toEqual(["import-1"]);
    expect(module.getTradeLog()[0].partner).toBe("Kestrel");
  });

  it("suppresses the file-poll re-delivery but records an identical later trade", async () => {
    vi.useFakeTimers();
    try {
      const module = await tracker();
      const trade = {
        partner: "T4092",
        platChange: 15,
        type: "sale" as const,
        items: [{ displayName: "Vitus Essence", count: 1, direction: "given" as const }],
      };
      expect(module.recordTradeFromLog(trade)).not.toBeNull();
      vi.advanceTimersByTime(14_000);
      expect(module.recordTradeFromLog(trade)).toBeNull();
      expect(module.getTradeLog()).toHaveLength(1);
      vi.advanceTimersByTime(60_000);
      expect(module.recordTradeFromLog(trade)).not.toBeNull();
      expect(module.getTradeLog()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an identical repeat inside the window when the log stamps differ", async () => {
    const module = await tracker();
    const trade = {
      partner: "T4092",
      platChange: 15,
      type: "sale" as const,
      items: [{ displayName: "Vitus Essence", count: 1, direction: "given" as const }],
    };

    expect(module.recordTradeFromLog({ ...trade, logStamp: "1200.500" })).not.toBeNull();
    expect(module.recordTradeFromLog({ ...trade, logStamp: "1200.500" })).toBeNull();
    expect(module.recordTradeFromLog({ ...trade, logStamp: "1212.750" })).not.toBeNull();
    expect(module.getTradeLog()).toHaveLength(2);
  });

  it("still suppresses re-delivery when one side carries no stamp", async () => {
    const module = await tracker();
    const trade = {
      partner: "T4092",
      platChange: 15,
      type: "sale" as const,
      items: [{ displayName: "Vitus Essence", count: 1, direction: "given" as const }],
    };

    expect(module.recordTradeFromLog(trade)).not.toBeNull();
    expect(module.recordTradeFromLog({ ...trade, logStamp: "1200.500" })).toBeNull();
    expect(module.getTradeLog()).toHaveLength(1);
  });

  it("records distinct back-to-back trades", async () => {
    const module = await tracker();
    expect(
      module.recordTradeFromLog({
        partner: "BuyerA",
        platChange: 10,
        type: "sale",
        items: [{ displayName: "Forma Blueprint", count: 1, direction: "given" }],
      }),
    ).not.toBeNull();
    expect(
      module.recordTradeFromLog({
        partner: "BuyerB",
        platChange: 25,
        type: "sale",
        items: [{ displayName: "Ash Prime Chassis", count: 1, direction: "given" }],
      }),
    ).not.toBeNull();
    expect(module.getTradeLog()).toHaveLength(2);
  });

  // Shapes an older parser persisted, which still sit in saved trade logs.
  it("repairs persisted entries corrupted by the old trade-dialog parser", async () => {
    const module = await tracker();
    const item = (displayName: string) => ({
      internalName: "",
      displayName,
      count: 1,
      direction: "given",
    });
    fs.writeFileSync(
      path.join(tmpDir, "trade-log.json"),
      JSON.stringify([
        {
          id: "glyphs",
          date: `${YEAR}-07-20T10:00:00.000Z`,
          type: "sale",
          platChange: 45,
          partner: "Kestrel\uE000",
          items: [
            item("Zid-an Asheir\uE000\uE001"),
            item("\uE000\uE001\uE002\uE003"),
            item("Zid-an Asheir, title= leftItem=/"),
          ],
        },
        {
          id: "raw-log-lines",
          date: `${YEAR}-07-20T11:00:00.000Z`,
          type: "trade",
          platChange: 0,
          items: [item("11828.904 Script [Info]: Dialog.lua: Dialog::")],
        },
      ]),
    );

    module.loadTradeLog();
    const events = module.getTradeLog();
    // The all-corrupt event is dropped entirely.
    expect(events.map((e) => e.id)).toEqual(["glyphs"]);
    expect(events[0].partner).toBe("Kestrel");
    // Glyphs and Dialog arg tails stripped; the glyph-only item removed.
    expect(events[0].items.map((i) => i.displayName)).toEqual(["Zid-an Asheir", "Zid-an Asheir"]);
  });
});
