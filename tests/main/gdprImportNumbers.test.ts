import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function importer(): Promise<typeof import("../../services/gdprImport")> {
  const module = await import("../../services/gdprImport");
  module.__resetGdprImportForTest();
  return module;
}

function csv(rows: string[]): string {
  return ["Date;Type;Item;Platinum;Credits;Tax;Partner", ...rows].join("\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdpr-number-test-"));
});

afterEach(async () => {
  (await importer()).__resetGdprImportForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The same export that prints 04.03.2025 prints 1.234 for 1234, so the number
// style has to be inferred per value like the date style already is.
describe("locale-formatted numbers", () => {
  it("reads dot-grouped thousands instead of a fraction", async () => {
    const parse = (await importer()).parseGdprTradeExport;
    const result = parse(
      csv(["04.03.2025;Sale;Ash Prime Chassis;1.234;2.500.000;8.000;Kestrel"]),
      "trades.csv",
      [],
    );

    expect(result.counts.rejected).toBe(0);
    const [event] = result.events;
    expect(event.platChange).toBe(1234);
    expect(event.credits).toBe(2_500_000);
    expect(event.tradeTax).toBe(8000);
  });

  it("takes the rightmost separator as the decimal point", async () => {
    const parse = (await importer()).parseGdprTradeExport;
    const result = parse(
      csv([
        "05.03.2025;Sale;Ash Prime Chassis;1.234,00;9.999,20;0;Vor",
        "06.03.2025;Sale;Ash Prime Chassis;1,234.00;9,999.20;0;Vor",
        "07.03.2025;Sale;Ash Prime Chassis;1.234,100;9.999,200;0;Vor",
      ]),
      "trades.csv",
      [],
    );

    expect(result.events.map((event) => event.platChange)).toEqual([1234, 1234, 1234]);
    expect(result.events.map((event) => event.credits)).toEqual([9999, 9999, 9999]);
  });

  it("reads a repeated separator as thousands even when a group is short", async () => {
    const parse = (await importer()).parseGdprTradeExport;
    const result = parse(
      csv([
        "08.03.2025;Sale;Ash Prime Chassis;1,234,56;7.654,32;0;Vor",
        "09.03.2025;Sale;Ash Prime Chassis;12.345.6;0;0;Vor",
      ]),
      "trades.csv",
      [],
    );

    expect(result.counts.rejected).toBe(0);
    expect(result.events.map((event) => event.platChange)).toEqual([123456, 123456]);
    expect(result.events[0].credits).toBe(7654);
  });

  it("still reads comma-grouped and plain numbers", async () => {
    const parse = (await importer()).parseGdprTradeExport;
    const result = parse(
      csv([
        "2025-03-07;Sale;Ash Prime Chassis;1,234;2,500,000;8,000;Vor",
        "2025-03-08;Sale;Ash Prime Chassis;45;;;Vor",
      ]),
      "trades.csv",
      [],
    );

    expect(result.events.map((event) => event.platChange)).toEqual([1234, 45]);
    expect(result.events[0].credits).toBe(2_500_000);
    expect(result.events[0].tradeTax).toBe(8000);
    expect(result.events[1].credits).toBeUndefined();
  });
});
