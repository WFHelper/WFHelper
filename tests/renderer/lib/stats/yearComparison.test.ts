import { describe, expect, it } from "vitest";

import { yearComparison } from "../../../../src/lib/stats/tradeAnalytics.js";
import type { TradeEvent, TradeItem, TradeType } from "../../../../src/types/ipc.js";

let seq = 0;

function item(direction: "given" | "received"): TradeItem {
  return { internalName: "/Lotus/Thing", displayName: "Thing", count: 1, direction };
}

/** Local-noon ISO so a timezone shift cannot roll the day key over. */
function at(day: string): string {
  return `${day}T12:00:00.000`;
}

function ev(day: string, type: TradeType, plat: number): TradeEvent {
  return {
    id: `e${++seq}`,
    date: at(day),
    type,
    platChange: plat,
    items: [item(type === "purchase" ? "received" : "given")],
  };
}

describe("yearComparison spans", () => {
  it("stops the previous year on the same day as now", () => {
    const cmp = yearComparison(
      [
        ev("2026-02-01", "sale", 150),
        ev("2025-02-01", "sale", 100),
        // Later than now's day, so it belongs to the part of 2025 not yet lived.
        ev("2025-11-01", "sale", 900),
      ],
      new Date(2026, 5, 1),
    );
    expect(cmp.current.platIn).toBe(150);
    expect(cmp.previous.platIn).toBe(100);
    expect(cmp.netDeltaPct).toBeCloseTo(50);
  });

  it("includes the previous year's boundary day and excludes the day after", () => {
    const now = new Date(2026, 5, 15);
    const onBoundary = yearComparison([ev("2025-06-15", "sale", 40)], now);
    expect(onBoundary.previous.platIn).toBe(40);
    expect(onBoundary.hasPrevious).toBe(true);
    const dayAfter = yearComparison([ev("2025-06-16", "sale", 40)], now);
    expect(dayAfter.previous.platIn).toBe(0);
    expect(dayAfter.hasPrevious).toBe(false);
  });

  it("covers the whole previous year on Dec 31", () => {
    const cmp = yearComparison(
      [ev("2025-01-01", "sale", 10), ev("2025-12-31", "sale", 20)],
      new Date(2026, 11, 31),
    );
    expect(cmp.previous.platIn).toBe(30);
    expect(cmp.previous.events).toBe(2);
  });

  it("clamps a leap-day now to Feb 28 of the common year", () => {
    const now = new Date(2028, 1, 29);
    const cmp = yearComparison(
      [ev("2027-02-28", "sale", 60), ev("2027-03-01", "sale", 500), ev("2028-02-29", "sale", 90)],
      now,
    );
    expect(cmp.previous.platIn).toBe(60);
    expect(cmp.current.platIn).toBe(90);
  });

  it("keeps a previous leap day once now is past it", () => {
    const now = new Date(2029, 2, 1);
    expect(yearComparison([ev("2028-02-29", "sale", 25)], now).previous.platIn).toBe(25);
    // Feb 28 has not reached the leap day yet, so it stays out.
    expect(
      yearComparison([ev("2028-02-29", "sale", 25)], new Date(2029, 1, 28)).previous.platIn,
    ).toBe(0);
  });

  it("drops events dated after today from the current column", () => {
    const cmp = yearComparison(
      [ev("2026-03-01", "sale", 70), ev("2026-12-24", "sale", 400)],
      new Date(2026, 5, 1),
    );
    expect(cmp.current.platIn).toBe(70);
  });
});
