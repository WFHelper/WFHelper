import { describe, expect, it } from "vitest";

import { monthlyFlow, parseDateKey } from "../../../../src/lib/stats/tradeAnalytics.js";
import type { TradeEvent } from "../../../../src/types/ipc.js";

function sale(day: string, plat: number): TradeEvent {
  return {
    id: `e-${day}`,
    date: `${day}T12:00:00`,
    type: "sale",
    platChange: plat,
    items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
  };
}

describe("parseDateKey", () => {
  it("reads a month key and a day key", () => {
    expect(parseDateKey("2026-05")).toEqual({ year: 2026, month: 5, day: 1 });
    expect(parseDateKey("2026-05-09")).toEqual({ year: 2026, month: 5, day: 9 });
  });

  it("rejects a key that is not a full month or day", () => {
    // Number("") is 0, so these all used to pass a Number.isFinite guard.
    for (const key of ["2026", "2026-", "2026-5", "2026-05-", "", "not-a-key"]) {
      expect(parseDateKey(key)).toBeNull();
    }
  });

  it("rejects an out-of-range month or day", () => {
    for (const key of ["2026-00", "2026-13", "2026-05-00", "2026-05-32"]) {
      expect(parseDateKey(key)).toBeNull();
    }
  });
});

describe("monthlyFlow month stepping", () => {
  it("fills across a year boundary", () => {
    const rows = monthlyFlow(
      [sale("2025-11-20", 10), sale("2026-02-02", 20)],
      24,
      {},
      new Date(2026, 1, 15),
    );
    expect(rows.map((r) => r.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(rows[0].platIn).toBe(10);
    expect(rows[3].platIn).toBe(20);
  });

  it("ignores a bound that is not a date key instead of labelling a bar with it", () => {
    expect(monthlyFlow([], 24, { from: "2026" }, new Date(2026, 8, 5))).toEqual([]);
    const rows = monthlyFlow([sale("2026-08-02", 5)], 24, { from: "2026" }, new Date(2026, 8, 5));
    expect(rows.map((r) => r.month)).toEqual(["2026-08"]);
  });

  it("extends the axis to today from a real bound", () => {
    const rows = monthlyFlow(
      [sale("2026-08-02", 5)],
      24,
      { from: "2026-06-01" },
      new Date(2026, 8, 5),
    );
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(rows[2].platIn).toBe(5);
  });
});
