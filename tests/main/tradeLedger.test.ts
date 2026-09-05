import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TradeEvent } from "../../config/shared/statsTypes";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/statsTracker", () => ({ incrementTodayTrades: vi.fn() }));
vi.mock("../../services/wfmCatalog", () => ({ lookupByName: vi.fn(() => null) }));

type Tracker = typeof import("../../services/tradeTracker");
type Store = typeof import("../../services/tradeLedgerStore");

const YEAR = new Date().getUTCFullYear();

async function modules(): Promise<{ tracker: Tracker; store: Store }> {
  const tracker = await import("../../services/tradeTracker");
  const store = await import("../../services/tradeLedgerStore");
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  return { tracker, store };
}

function event(id: string, date: string, extra: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id,
    date,
    type: "sale",
    platChange: 10,
    items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
    partner: "Kestrel",
    ...extra,
  };
}

function writeLiveLog(events: TradeEvent[]): void {
  fs.writeFileSync(path.join(tmpDir, "trade-log.json"), JSON.stringify(events));
}

function readArchiveFile(year: number): TradeEvent[] {
  const file = path.join(tmpDir, "trade-ledger", `${year}.json.gz`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf-8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
});

afterEach(async () => {
  const { tracker, store } = await modules();
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("trade log migration", () => {
  it("stamps legacy rows with schemaVersion and source without changing ids", async () => {
    const { tracker } = await modules();
    writeLiveLog([event("legacy-1", `${YEAR}-01-02T10:00:00.000Z`)]);

    tracker.loadTradeLog();
    const [row] = tracker.getTradeLog();
    expect(row.id).toBe("legacy-1");
    expect(row.schemaVersion).toBe(2);
    expect(row.source).toBe("live");
  });

  it("keeps a row's own source instead of forcing it back to live", async () => {
    const { tracker } = await modules();
    writeLiveLog([
      event("imported-1", `${YEAR}-01-02T10:00:00.000Z`, {
        source: "gdpr",
        sourceRecordId: "abc",
        importBatchId: "batch-1",
        credits: 500,
        tradeTax: 2000,
      }),
    ]);

    tracker.loadTradeLog();
    const [row] = tracker.getTradeLog();
    expect(row.source).toBe("gdpr");
    expect(row.sourceRecordId).toBe("abc");
    expect(row.importBatchId).toBe("batch-1");
    expect(row.credits).toBe(500);
    expect(row.tradeTax).toBe(2000);
  });
});

describe("rotation", () => {
  it("archives previous years, keeps this year live and backs the log up first", async () => {
    const { tracker } = await modules();
    const rows = [
      event("this-year", `${YEAR}-05-05T10:00:00.000Z`),
      event("last-year", `${YEAR - 1}-11-02T10:00:00.000Z`),
      event("older", `${YEAR - 2}-02-02T10:00:00.000Z`),
    ];
    writeLiveLog(rows);

    tracker.loadTradeLog();

    expect(tracker.getTradeLog().map((e) => e.id)).toEqual(["this-year"]);
    expect(readArchiveFile(YEAR - 1).map((e) => e.id)).toEqual(["last-year"]);
    expect(readArchiveFile(YEAR - 2).map((e) => e.id)).toEqual(["older"]);

    const backupDir = path.join(tmpDir, "trade-ledger", "backup");
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    const backed: TradeEvent[] = JSON.parse(
      fs.readFileSync(path.join(backupDir, backups[0]), "utf-8"),
    );
    expect(backed.map((e) => e.id).sort()).toEqual(["last-year", "older", "this-year"]);

    // The live file on disk matches the trimmed in-memory log.
    const live: TradeEvent[] = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "trade-log.json"), "utf-8"),
    );
    expect(live.map((e) => e.id)).toEqual(["this-year"]);
  });

  it("backs the live log up only once across restarts", async () => {
    const { tracker } = await modules();
    writeLiveLog([event("older", `${YEAR - 2}-02-02T10:00:00.000Z`)]);
    tracker.loadTradeLog();

    writeLiveLog([event("older-2", `${YEAR - 2}-03-03T10:00:00.000Z`)]);
    const second = await modules();
    second.tracker.loadTradeLog();

    expect(fs.readdirSync(path.join(tmpDir, "trade-ledger", "backup"))).toHaveLength(1);
    expect(
      readArchiveFile(YEAR - 2)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["older", "older-2"]);
  });

  it("isolates a corrupt archive: its rows stay live and other years still rotate", async () => {
    const { tracker, store } = await modules();
    const ledgerDir = path.join(tmpDir, "trade-ledger");
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, `${YEAR - 1}.json.gz`), "not gzip at all");

    writeLiveLog([
      event("this-year", `${YEAR}-05-05T10:00:00.000Z`),
      event("last-year", `${YEAR - 1}-11-02T10:00:00.000Z`),
      event("older", `${YEAR - 2}-02-02T10:00:00.000Z`),
    ]);

    expect(() => tracker.loadTradeLog()).not.toThrow();

    // The corrupt year is never rewritten, so its bytes survive untouched.
    expect(fs.readFileSync(path.join(ledgerDir, `${YEAR - 1}.json.gz`), "utf-8")).toBe(
      "not gzip at all",
    );
    expect(
      tracker
        .getTradeLog()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["last-year", "this-year"]);
    expect(readArchiveFile(YEAR - 2).map((e) => e.id)).toEqual(["older"]);

    const page = store.queryLedger({}, tracker.getTradeLog());
    expect(page.unreadableYears).toEqual([YEAR - 1]);
    expect(page.events.map((e) => e.id).sort()).toEqual(["last-year", "older", "this-year"]);
  });

  it("survives a crash between the archive write and the live rewrite", async () => {
    const { tracker } = await modules();
    const stale = event("older", `${YEAR - 2}-02-02T10:00:00.000Z`);
    writeLiveLog([stale]);
    tracker.loadTradeLog();

    // Simulate the pre-crash live file coming back with the already-archived row.
    writeLiveLog([stale, event("older-2", `${YEAR - 2}-03-03T10:00:00.000Z`)]);
    const second = await modules();
    second.tracker.loadTradeLog();

    expect(
      readArchiveFile(YEAR - 2)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["older", "older-2"]);
    expect(second.store.queryLedger({}, second.tracker.getTradeLog()).total).toBe(2);
  });
});

describe("legacy import path", () => {
  it("does not resurrect archived rows when the same export is imported twice", async () => {
    const { tracker } = await modules();
    const rows = [event("aleca-1", `${YEAR - 1}-04-04T10:00:00.000Z`)];

    expect(tracker.importTradeLog(rows)).toBe(1);
    expect(tracker.getTradeLog()).toHaveLength(0);
    expect(readArchiveFile(YEAR - 1).map((e) => e.id)).toEqual(["aleca-1"]);

    expect(tracker.importTradeLog(rows)).toBe(0);
    expect(readArchiveFile(YEAR - 1)).toHaveLength(1);
  });

  it("keeps archived years visible to the stats trade list", async () => {
    const { tracker } = await modules();
    writeLiveLog([
      event("this-year", `${YEAR}-05-05T10:00:00.000Z`),
      event("last-year", `${YEAR - 1}-11-02T10:00:00.000Z`),
    ]);
    tracker.loadTradeLog();

    expect(tracker.getTradeLog().map((e) => e.id)).toEqual(["this-year"]);
    expect(tracker.getRecentTradeLog().map((e) => e.id)).toEqual(["this-year", "last-year"]);
  });
});

describe("live log cap", () => {
  it("keeps an overflow row that belongs to no archive year in the live log", async () => {
    const { tracker } = await modules();
    const rows = Array.from({ length: 2400 }, (_unused, index) =>
      event(`row-${index}`, `${YEAR}-01-01T00:00:00.000Z`),
    );
    // Parses as a date but predates any possible trade, so no archive owns it.
    rows.push(event("prehistoric", "1970-01-01T00:00:00.000Z"));
    writeLiveLog(rows);

    tracker.loadTradeLog();

    expect(tracker.getTradeLog().some((e) => e.id === "prehistoric")).toBe(true);
  });

  it("spills the overflow into this year's archive instead of dropping it", async () => {
    const { tracker, store } = await modules();
    const rows = Array.from({ length: 2400 }, (_unused, index) =>
      event(`row-${index}`, `${YEAR}-01-01T00:00:00.000Z`),
    );
    writeLiveLog(rows);

    tracker.loadTradeLog();

    expect(tracker.getTradeLog()).toHaveLength(2000);
    expect(readArchiveFile(YEAR)).toHaveLength(400);
    expect(store.queryLedger({}, tracker.getTradeLog()).total).toBe(2400);
  });
});

describe("live log cap boundary", () => {
  function rows(count: number): TradeEvent[] {
    return Array.from({ length: count }, (_unused, index) =>
      event(`row-${index}`, `${YEAR}-01-01T00:00:00.000Z`),
    );
  }

  it("leaves exactly 2000 rows live and writes no archive", async () => {
    const { tracker } = await modules();
    writeLiveLog(rows(2000));

    tracker.loadTradeLog();

    expect(tracker.getTradeLog()).toHaveLength(2000);
    expect(fs.existsSync(path.join(tmpDir, "trade-ledger", `${YEAR}.json.gz`))).toBe(false);
  });

  it("spills the 2001st row so an older release can never truncate it away", async () => {
    const { tracker, store } = await modules();
    writeLiveLog(rows(2001));

    tracker.loadTradeLog();

    expect(tracker.getTradeLog()).toHaveLength(2000);
    expect(readArchiveFile(YEAR)).toHaveLength(1);
    expect(store.queryLedger({}, tracker.getTradeLog()).total).toBe(2001);
  });
});

describe("local calendar day filtering", () => {
  const NEGATIVE_OFFSET_TZ = "America/New_York";
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = NEGATIVE_OFFSET_TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("puts a New Year row on the local day and spans both archive years", async () => {
    const { tracker, store } = await modules();
    writeLiveLog([
      // 02:00 UTC on Jan 1 is still Dec 31 of the previous year in New York.
      event("nye", `${YEAR}-01-01T02:00:00.000Z`),
      event("old", `${YEAR - 1}-06-06T10:00:00.000Z`),
    ]);
    tracker.loadTradeLog();
    const live = tracker.getTradeLog();

    // "old" rotated into the previous year's archive, "nye" is still live.
    expect(live.map((e) => e.id)).toEqual(["nye"]);
    expect(readArchiveFile(YEAR - 1).map((e) => e.id)).toEqual(["old"]);

    const lastYear = store.queryLedger(
      { from: `${YEAR - 1}-01-01`, to: `${YEAR - 1}-12-31` },
      live,
    );
    expect(lastYear.events.map((e) => e.id)).toEqual(["nye", "old"]);

    const thisYear = store.queryLedger({ from: `${YEAR}-01-01` }, live);
    expect(thisYear.events.map((e) => e.id)).toEqual([]);

    const newYearsEve = store.queryLedger(
      { from: `${YEAR - 1}-12-31`, to: `${YEAR - 1}-12-31` },
      live,
    );
    expect(newYearsEve.events.map((e) => e.id)).toEqual(["nye"]);
  });

  it("keeps both sides of the spring-forward gap on their own local day", async () => {
    const { tracker, store } = await modules();
    // US DST starts on the second Sunday in March, when 02:00 becomes 03:00.
    const march1 = new Date(Date.UTC(YEAR, 2, 1));
    const secondSunday = 1 + ((7 - march1.getUTCDay()) % 7) + 7;
    const day = `${YEAR}-03-${String(secondSunday).padStart(2, "0")}`;
    const dayBefore = `${YEAR}-03-${String(secondSunday - 1).padStart(2, "0")}`;
    writeLiveLog([
      // 23:30 EST the evening before, then 01:30 EST and 03:30 EDT on the day.
      event("eve", `${day}T04:30:00.000Z`),
      event("before-gap", `${day}T06:30:00.000Z`),
      event("after-gap", `${day}T07:30:00.000Z`),
    ]);
    tracker.loadTradeLog();
    const live = tracker.getTradeLog();

    expect(store.queryLedger({ from: day, to: day }, live).events.map((e) => e.id)).toEqual([
      "after-gap",
      "before-gap",
    ]);
    expect(
      store.queryLedger({ from: dayBefore, to: dayBefore }, live).events.map((e) => e.id),
    ).toEqual(["eve"]);
  });
});

describe("queryLedger", () => {
  async function seeded(): Promise<{ tracker: Tracker; store: Store }> {
    const mods = await modules();
    writeLiveLog([
      event("a", `${YEAR}-05-05T10:00:00.000Z`, { partner: "Kestrel", type: "sale" }),
      event("b", `${YEAR}-06-06T10:00:00.000Z`, {
        partner: "Vor",
        type: "purchase",
        items: [
          { internalName: "", displayName: "Nikana Prime Blade", count: 1, direction: "received" },
        ],
      }),
      event("c", `${YEAR - 1}-06-06T10:00:00.000Z`, { partner: "Ordis", type: "trade" }),
    ]);
    mods.tracker.loadTradeLog();
    return mods;
  }

  it("filters by date range, type and text over items and partner", async () => {
    const { tracker, store } = await seeded();
    const live = tracker.getTradeLog();

    expect(store.queryLedger({ type: "purchase" }, live).events.map((e) => e.id)).toEqual(["b"]);
    expect(
      store
        .queryLedger({ from: `${YEAR}-06-01`, to: `${YEAR}-06-30` }, live)
        .events.map((e) => e.id),
    ).toEqual(["b"]);
    expect(store.queryLedger({ text: "nikana" }, live).events.map((e) => e.id)).toEqual(["b"]);
    expect(store.queryLedger({ text: "ordis" }, live).events.map((e) => e.id)).toEqual(["c"]);
    expect(store.queryLedger({ text: "nothing here" }, live).total).toBe(0);
  });

  it("reports the total across live and archives, newest first", async () => {
    const { tracker, store } = await seeded();
    const page = store.queryLedger({}, tracker.getTradeLog());
    expect(page.total).toBe(3);
    expect(page.events.map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(page.unreadableYears).toEqual([]);
  });

  it("clamps offset and limit instead of trusting the caller", async () => {
    const { tracker, store } = await seeded();
    const live = tracker.getTradeLog();

    expect(store.queryLedger({ limit: 9999 }, live).events).toHaveLength(3);
    expect(store.queryLedger({ limit: 0 }, live).events).toHaveLength(3);
    expect(store.queryLedger({ limit: -5 }, live).events).toHaveLength(3);
    expect(store.queryLedger({ limit: 1, offset: 1 }, live).events.map((e) => e.id)).toEqual(["a"]);
    expect(store.queryLedger({ offset: -10, limit: 1 }, live).events.map((e) => e.id)).toEqual([
      "b",
    ]);
    expect(store.queryLedger({ limit: 1 }, live).total).toBe(3);
    // Main forwards raw numbers, so every bound is settled here.
    expect(store.queryLedger({ limit: 1.9 }, live).events.map((e) => e.id)).toEqual(["b"]);
    expect(store.queryLedger({ limit: Number.NaN }, live).events).toHaveLength(3);
    const past = store.queryLedger({ offset: 10 }, live);
    expect(past.events).toEqual([]);
    expect(past.total).toBe(3);
  });
});

describe("patching a row", () => {
  it("keeps id and provenance on a live row and stamps editedAt", async () => {
    const { tracker } = await modules();
    writeLiveLog([
      event("live-1", `${YEAR}-05-05T10:00:00.000Z`, {
        source: "gdpr",
        sourceRecordId: "record-1",
        importBatchId: "batch-1",
      }),
    ]);
    tracker.loadTradeLog();

    expect(tracker.patchLiveTradeEvent("live-1", { platChange: 55, partner: "Ordis" })).toBe(true);
    const [row] = tracker.getTradeLog();
    expect(row.id).toBe("live-1");
    expect(row.platChange).toBe(55);
    expect(row.partner).toBe("Ordis");
    expect(row.source).toBe("gdpr");
    expect(row.sourceRecordId).toBe("record-1");
    expect(row.importBatchId).toBe("batch-1");
    expect(row.editedAt).toBeTruthy();
  });

  it("rewrites the archive for a row that already rotated out", async () => {
    const { tracker, store } = await modules();
    writeLiveLog([
      event("old-1", `${YEAR - 1}-05-05T10:00:00.000Z`, {
        source: "gdpr",
        sourceRecordId: "record-9",
      }),
    ]);
    tracker.loadTradeLog();
    expect(tracker.patchLiveTradeEvent("old-1", { type: "trade" })).toBe(false);

    expect(store.patchArchivedEvent("old-1", { type: "trade", credits: 1000 })).toBe(true);
    const [archived] = readArchiveFile(YEAR - 1);
    expect(archived.id).toBe("old-1");
    expect(archived.type).toBe("trade");
    expect(archived.credits).toBe(1000);
    expect(archived.sourceRecordId).toBe("record-9");
    expect(archived.editedAt).toBeTruthy();

    expect(store.patchArchivedEvent("missing", { type: "sale" })).toBe(false);
  });
});
