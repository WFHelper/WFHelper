import { describe, expect, it } from "vitest";

import {
  monthlyFlow,
  partnerRollup,
  recentDailyFlow,
  todayFlow,
} from "../../../../src/lib/stats/tradeAnalytics.js";
import type { TradeEvent, TradeItem, TradeType } from "../../../../src/types/ipc.js";

let seq = 0;

function item(name: string, direction: "given" | "received"): TradeItem {
  return { internalName: `/Lotus/${name}`, displayName: name, count: 1, direction };
}

/** Local-noon ISO so a timezone shift cannot roll the day key over. */
function at(day: string): string {
  return `${day}T12:00:00.000`;
}

function ev(day: string, type: TradeType, plat: number, partner?: string): TradeEvent {
  return {
    id: `e${++seq}`,
    date: at(day),
    type,
    platChange: plat,
    items: [item("Thing", type === "purchase" ? "received" : "given")],
    ...(partner ? { partner } : {}),
  };
}

describe("partnerRollup", () => {
  it("splits each partner's sales and purchases", () => {
    const rows = partnerRollup([
      ev("2026-03-01", "sale", 100, "Alice"),
      ev("2026-03-02", "sale", 50, "Alice"),
      ev("2026-03-03", "purchase", 30, "Alice"),
      ev("2026-03-04", "sale", 20, "Bob"),
    ]);
    expect(rows[0]).toMatchObject({
      partner: "Alice",
      sales: 2,
      salesPlat: 150,
      purchases: 1,
      purchasesPlat: 30,
      total: 180,
    });
    expect(rows[1]).toMatchObject({ partner: "Bob", total: 20 });
  });

  it("groups rows without a partner under one empty bucket", () => {
    const rows = partnerRollup([ev("2026-03-01", "sale", 10), ev("2026-03-02", "sale", 5)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner: "", sales: 2, total: 15 });
  });

  it("ignores swaps and keeps only the top rows", () => {
    const events = [
      ev("2026-03-01", "trade", 0, "Swapper"),
      ...Array.from({ length: 12 }, (_unused, index) =>
        ev("2026-03-02", "sale", index + 1, `P${index}`),
      ),
    ];
    const rows = partnerRollup(events, 3);
    expect(rows.map((r) => r.partner)).toEqual(["P11", "P10", "P9"]);
  });
});

describe("monthlyFlow", () => {
  it("buckets by local calendar month and fills the gaps", () => {
    const rows = monthlyFlow([
      ev("2026-01-05", "sale", 100),
      ev("2026-01-20", "purchase", 40),
      ev("2026-03-02", "sale", 10),
    ]);
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(rows[0]).toMatchObject({ platIn: 100, platOut: 40, net: 60 });
    expect(rows[1]).toMatchObject({ platIn: 0, platOut: 0, net: 0 });
    expect(rows[2]).toMatchObject({ platIn: 10, net: 10 });
  });

  it("rolls the year over and keeps only the newest months", () => {
    const rows = monthlyFlow([ev("2025-11-01", "sale", 1), ev("2026-02-01", "sale", 2)], 2);
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02"]);
  });

  it("returns nothing for an empty range", () => {
    expect(monthlyFlow([])).toEqual([]);
  });

  it("extends the axis to the selected range end, capped at the current month", () => {
    const now = new Date(2026, 8, 2); // 2026-09-02 local
    const rows = monthlyFlow(
      [ev("2026-02-01", "sale", 5)],
      24,
      { from: "2026-01-01", to: "2026-12-31" },
      now,
    );
    expect(rows.map((r) => r.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(rows[0].net).toBe(0);
    expect(rows[1].net).toBe(5);
  });
});

describe("recentDailyFlow", () => {
  const now = new Date(2026, 2, 10, 15, 0, 0); // 2026-03-10 local

  it("returns a contiguous window ending today", () => {
    const rows = recentDailyFlow([], 10, now);
    expect(rows).toHaveLength(10);
    expect(rows[0].day).toBe("2026-03-01");
    expect(rows[9].day).toBe("2026-03-10");
  });

  it("scores platinum on its own day and drops anything older", () => {
    const rows = recentDailyFlow(
      [
        ev("2026-03-09", "sale", 80),
        ev("2026-03-09", "purchase", 30),
        ev("2026-02-01", "sale", 500),
      ],
      10,
      now,
    );
    expect(rows[8]).toMatchObject({ day: "2026-03-09", platIn: 80, platOut: 30, net: 50 });
    expect(rows.reduce((sum, r) => sum + r.platIn, 0)).toBe(80);
  });
});

describe("todayFlow", () => {
  const now = new Date(2026, 2, 10, 15, 0, 0);

  it("counts only today's sales and purchases", () => {
    const flow = todayFlow(
      [
        ev("2026-03-10", "sale", 70),
        ev("2026-03-10", "sale", 30),
        ev("2026-03-10", "purchase", 25),
        ev("2026-03-09", "sale", 999),
      ],
      now,
    );
    expect(flow).toMatchObject({ sales: 2, purchases: 1, platIn: 100, platOut: 25, net: 75 });
  });

  it("reports an empty day as zero, not as the whole range", () => {
    expect(todayFlow([ev("2026-03-01", "sale", 40)], now)).toMatchObject({
      sales: 0,
      purchases: 0,
      net: 0,
    });
  });
});
