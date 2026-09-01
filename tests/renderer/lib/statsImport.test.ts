import { describe, expect, it } from "vitest";

import {
  assertStatsImportFileSize,
  isValidStatsImportPayload,
  sanitizeStatsImportEntries,
  MAX_STATS_IMPORT_FILE_BYTES,
  MAX_STATS_IMPORT_ROWS,
  MAX_TRADE_IMPORT_ROWS,
} from "../../../config/shared/statsImport.js";
import {
  normalizeAlecaFrameStats,
  parseAlecaFrameTrades,
} from "../../../src/lib/stats/importAlecaFrame.js";
import type { DailyStatEntry } from "../../../config/shared/statsTypes.js";

const VALID_ROW: DailyStatEntry = {
  date: "2026-01-01",
  platDelta: -10,
  creditsDelta: 200,
  endoDelta: 0,
  ducatsDelta: 0,
  ayaDelta: 0,
  vitusDelta: 0,
  relicsOpened: 2,
  daysPlayed: 1,
  dailyTrades: 3,
};

describe("stats import limits", () => {
  it("accepts 50 MB and rejects one byte more", () => {
    expect(() => assertStatsImportFileSize(MAX_STATS_IMPORT_FILE_BYTES)).not.toThrow();
    expect(() => assertStatsImportFileSize(MAX_STATS_IMPORT_FILE_BYTES + 1)).toThrow("50 MB");
  });

  it("accepts 10,000 daily rows and rejects one more", () => {
    expect(
      normalizeAlecaFrameStats(Array.from({ length: MAX_STATS_IMPORT_ROWS }, () => null)),
    ).toEqual([]);
    expect(() =>
      normalizeAlecaFrameStats(Array.from({ length: MAX_STATS_IMPORT_ROWS + 1 }, () => null)),
    ).toThrow(`${MAX_STATS_IMPORT_ROWS} rows`);
  });

  it("validates the stored daily-row shape", () => {
    expect(isValidStatsImportPayload([VALID_ROW])).toBe(true);
    expect(isValidStatsImportPayload([{ ...VALID_ROW, date: "2026-02-30" }])).toBe(false);
    expect(isValidStatsImportPayload([{ ...VALID_ROW, platDelta: Number.NaN }])).toBe(false);
    expect(isValidStatsImportPayload([{ ...VALID_ROW, relicsOpened: -1 }])).toBe(false);
  });

  it("validates the resource map a hand-edited file can carry", () => {
    const withMap = (resources: unknown): unknown => [{ ...VALID_ROW, resources }];

    expect(isValidStatsImportPayload(withMap({ kuva: { delta: 500, abs: 1200 } }))).toBe(true);
    expect(isValidStatsImportPayload(withMap({ kuva: { delta: 500 } }))).toBe(true);
    // JSON parses 1e400 as Infinity, which used to become a NaN chart height.
    expect(isValidStatsImportPayload(withMap({ kuva: { delta: JSON.parse("1e400") } }))).toBe(
      false,
    );
    expect(isValidStatsImportPayload(withMap({ kuva: { delta: 1, abs: Number.NaN } }))).toBe(false);
    expect(isValidStatsImportPayload(withMap({ kuva: 5 }))).toBe(false);
    expect(isValidStatsImportPayload(withMap([{ delta: 1 }]))).toBe(false);
    expect(isValidStatsImportPayload([{ ...VALID_ROW, resourcesVersion: 1.5 }])).toBe(false);
    expect(isValidStatsImportPayload([{ ...VALID_ROW, resourcesVersion: 1 }])).toBe(true);
  });

  it("keeps only catalog resource ids when importing", () => {
    const [row] = sanitizeStatsImportEntries([
      {
        ...VALID_ROW,
        resources: {
          kuva: { delta: 5, abs: 10 },
          vitus: { delta: -1 },
          madeUp: { delta: 9, abs: 9 },
        },
      },
    ]);

    expect(row.resources).toEqual({ kuva: { delta: 5, abs: 10 }, vitus: { delta: -1 } });
  });

  it("imports the app's own stats export back", () => {
    const exported = {
      exportedAt: "2026-08-13T00:00:00.000Z",
      history: [{ ...VALID_ROW, absPlat: 1234 }],
      trades: [
        {
          id: "trade-1",
          date: "2026-01-01T10:00:00.000Z",
          type: "sale",
          platChange: 50,
          items: [],
        },
      ],
    };

    expect(normalizeAlecaFrameStats(exported)).toEqual([{ ...VALID_ROW, absPlat: 1234 }]);
    expect(parseAlecaFrameTrades(exported)).toEqual(exported.trades);
  });

  it("stops parsing trades at the import limit", () => {
    const trades = Array.from({ length: MAX_TRADE_IMPORT_ROWS + 1 }, (_, index) => ({
      ts: `2026-01-01T00:00:${index}Z`,
      type: 0,
      totalPlat: index,
      user: "Trader",
    }));

    expect(parseAlecaFrameTrades({ trades })).toHaveLength(MAX_TRADE_IMPORT_ROWS);
  });
});
