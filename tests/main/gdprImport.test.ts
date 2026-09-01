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
vi.mock("../../services/wfmCatalog", () => ({
  lookupByName: (name: string) =>
    name === "Ash Prime Chassis" ? { url_name: "ash_prime_chassis", thumb: "ash.png" } : null,
}));

type Importer = typeof import("../../services/gdprImport");
type Tracker = typeof import("../../services/tradeTracker");
type Store = typeof import("../../services/tradeLedgerStore");

const LAST_YEAR = new Date().getUTCFullYear() - 1;

async function modules(): Promise<{ importer: Importer; tracker: Tracker; store: Store }> {
  const importer = await import("../../services/gdprImport");
  const tracker = await import("../../services/tradeTracker");
  const store = await import("../../services/tradeLedgerStore");
  importer.__resetGdprImportForTest();
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  return { importer, tracker, store };
}

const CSV = [
  "Date,Type,Item,Platinum,Partner",
  `${LAST_YEAR}-03-04,Sale,Ash Prime Chassis,45,Kestrel`,
  `${LAST_YEAR}-03-04,Sale,Ash Prime Chassis,45,Kestrel`,
  `${LAST_YEAR}-03-04,Purchase,Nikana Prime Blade,30,Vor`,
].join("\n");

function writeCsv(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

function archived(year: number): TradeEvent[] {
  const file = path.join(tmpDir, "trade-ledger", `${year}.json.gz`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf-8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdpr-test-"));
});

afterEach(async () => {
  const { importer, tracker, store } = await modules();
  importer.__resetGdprImportForTest();
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseGdprDate", () => {
  it("reads the date shapes an export plausibly ships", async () => {
    const { importer } = await modules();
    const parse = importer.parseGdprDate;

    expect(parse("2025-03-04")).toBe("2025-03-04T00:00:00.000Z");
    expect(parse("2025-03-04 18:30:00")).toBe("2025-03-04T18:30:00.000Z");
    expect(parse("2025-03-04T18:30:00Z")).toBe("2025-03-04T18:30:00.000Z");
    // Dotted is day-first; slashed defaults to US order unless day > 12.
    expect(parse("04.03.2025")).toBe("2025-03-04T00:00:00.000Z");
    expect(parse("03/04/2025")).toBe("2025-03-04T00:00:00.000Z");
    expect(parse("25/03/2025")).toBe("2025-03-25T00:00:00.000Z");
    expect(parse(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parse("1700000000")).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parse("who knows")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe("parseGdprTradeExport", () => {
  it("maps headers by meaning and resolves catalog names", async () => {
    const { importer } = await modules();
    const result = importer.parseGdprTradeExport(CSV, "trades.csv", new Set());

    expect(result.counts).toEqual({ parsed: 2, duplicates: 0, unresolved: 1, rejected: 0 });
    const [first] = result.events;
    expect(first.date.slice(0, 10)).toBe(`${LAST_YEAR}-03-04`);
    expect(first.type).toBe("sale");
    expect(first.platChange).toBe(45);
    expect(first.partner).toBe("Kestrel");
    expect(first.source).toBe("gdpr");
    expect(first.schemaVersion).toBe(2);
    expect(first.items[0].wfmSlug).toBe("ash_prime_chassis");

    const unresolvedRow = result.rows.find((row) => row.kind === "unresolved");
    expect(unresolvedRow?.summary).toContain("Nikana Prime Blade");
  });

  it("keeps two identical same-day trades from different source rows distinct", async () => {
    const { importer } = await modules();
    const result = importer.parseGdprTradeExport(CSV, "trades.csv", new Set());
    const ids = result.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(3);
    expect(result.counts.duplicates).toBe(0);
  });

  it("marks rows already in the ledger as duplicates", async () => {
    const { importer } = await modules();
    const first = importer.parseGdprTradeExport(CSV, "trades.csv", new Set());
    const known = new Set(first.events.map((event) => event.sourceRecordId ?? ""));

    const second = importer.parseGdprTradeExport(CSV, "trades.csv", known);
    expect(second.events).toHaveLength(0);
    expect(second.counts.duplicates).toBe(3);
  });

  it("rejects unreadable rows with a reason instead of failing the file", async () => {
    const { importer } = await modules();
    const body = [
      "Date,Type,Item,Platinum,Partner",
      `${LAST_YEAR}-03-04,Sale,Ash Prime Chassis,45,Kestrel`,
      "who-knows,Sale,Ash Prime Chassis,45,Kestrel",
      `${LAST_YEAR}-03-05,Sale,,,Ghost`,
    ].join("\n");

    const result = importer.parseGdprTradeExport(body, "trades.csv", new Set());
    expect(result.counts.parsed).toBe(1);
    expect(result.counts.rejected).toBe(2);
    const reasons = result.rows.filter((row) => row.kind === "rejected").map((row) => row.reason);
    expect(reasons).toContain("no readable date");
    expect(reasons).toContain("no items and no platinum");
  });

  it("reads JSON exports with a nested array and per-direction item lists", async () => {
    const { importer } = await modules();
    const body = JSON.stringify({
      account: { name: "Tenno" },
      tradeHistory: [
        {
          timestamp: `${LAST_YEAR}-04-05T12:30:00Z`,
          direction: "Bought",
          itemsReceived: [{ name: "Ash Prime Chassis", quantity: 2 }],
          itemsGiven: "Forma",
          platinum: 60,
          otherPlayer: "Vor",
          tradeTax: 8000,
        },
      ],
    });

    const result = importer.parseGdprTradeExport(body, "export.json", new Set());
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.type).toBe("purchase");
    expect(event.platChange).toBe(60);
    expect(event.tradeTax).toBe(8000);
    expect(event.partner).toBe("Vor");
    expect(event.items).toEqual([
      { internalName: "", displayName: "Forma", count: 1, direction: "given" },
      {
        internalName: "",
        displayName: "Ash Prime Chassis",
        count: 2,
        direction: "received",
        wfmSlug: "ash_prime_chassis",
        wfmThumb: "ash.png",
      },
    ]);
  });

  it("infers direction from signed platinum when no type column exists", async () => {
    const { importer } = await modules();
    const body = [
      "Date,Item,Platinum,Partner",
      `${LAST_YEAR}-03-04,Ash Prime Chassis,45,Kestrel`,
      `${LAST_YEAR}-03-05,Ash Prime Chassis,-30,Vor`,
    ].join("\n");

    const result = importer.parseGdprTradeExport(body, "trades.csv", new Set());
    expect(result.events.map((event) => event.type)).toEqual(["sale", "purchase"]);
    expect(result.events.map((event) => event.platChange)).toEqual([45, 30]);
  });
});

describe("preview and apply", () => {
  it("is a no-op on the second import of the same file", async () => {
    const { importer, tracker, store } = await modules();
    const file = writeCsv("trades.csv", CSV);
    tracker.loadTradeLog();

    const preview = importer.previewGdprImportFile(file, tracker.getLedgerEvents());
    expect("batchId" in preview).toBe(true);
    if (!("batchId" in preview)) return;
    expect(preview.counts.duplicates).toBe(0);

    const staged = importer.takeStagedImport(preview.batchId);
    expect(staged).not.toBeNull();
    const applied = tracker.addLedgerEvents(staged ?? []);
    expect(applied).toEqual({ applied: 3, skippedDuplicates: 0 });

    // Previous-year rows land straight in the archive, not in the live log.
    expect(tracker.getTradeLog()).toHaveLength(0);
    expect(archived(LAST_YEAR)).toHaveLength(3);

    const second = importer.previewGdprImportFile(file, tracker.getLedgerEvents());
    expect("batchId" in second).toBe(true);
    if (!("batchId" in second)) return;
    expect(second.counts).toEqual({ parsed: 0, duplicates: 3, unresolved: 0, rejected: 0 });

    const stagedAgain = importer.takeStagedImport(second.batchId);
    expect(tracker.addLedgerEvents(stagedAgain ?? [])).toEqual({
      applied: 0,
      skippedDuplicates: 0,
    });
    expect(store.queryLedger({}, tracker.getTradeLog()).total).toBe(3);
  });

  it("still dedups when the same rows are applied twice without a fresh preview", async () => {
    const { importer, tracker } = await modules();
    const file = writeCsv("trades.csv", CSV);
    tracker.loadTradeLog();

    const preview = importer.previewGdprImportFile(file, []);
    if (!("batchId" in preview)) throw new Error("preview failed");
    const staged = importer.takeStagedImport(preview.batchId) ?? [];

    expect(tracker.addLedgerEvents(staged).applied).toBe(3);
    expect(tracker.addLedgerEvents(staged)).toEqual({ applied: 0, skippedDuplicates: 3 });
  });

  it("stamps the batch id on applied rows and only serves a batch once", async () => {
    const { importer, tracker } = await modules();
    const file = writeCsv("trades.csv", CSV);
    tracker.loadTradeLog();

    const preview = importer.previewGdprImportFile(file, []);
    if (!("batchId" in preview)) throw new Error("preview failed");
    const staged = importer.takeStagedImport(preview.batchId) ?? [];
    expect(staged.every((event) => event.importBatchId === preview.batchId)).toBe(true);
    expect(importer.takeStagedImport(preview.batchId)).toBeNull();

    tracker.addLedgerEvents(staged);
    expect(archived(LAST_YEAR).every((event) => event.importBatchId === preview.batchId)).toBe(
      true,
    );
  });

  it("reports an error for a file with no recognisable rows", async () => {
    const { importer } = await modules();
    const file = writeCsv("empty.csv", "nothing to see here");
    const preview = importer.previewGdprImportFile(file, []);
    expect("error" in preview).toBe(true);
  });
});
