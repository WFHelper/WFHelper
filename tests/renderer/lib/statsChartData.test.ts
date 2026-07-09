import { describe, expect, it } from "vitest";

import { barsForKey } from "../../../src/lib/stats/chartData.js";
import type { DailyStatEntry } from "../../../src/types/ipc.js";

function dayStr(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function entry(date: string, absDucats?: number): DailyStatEntry {
  const base: DailyStatEntry = {
    date,
    platDelta: 0,
    creditsDelta: 0,
    endoDelta: 0,
    ducatsDelta: 0,
    ayaDelta: 0,
    relicsOpened: 0,
    daysPlayed: 1,
    dailyTrades: 0,
  };
  return absDucats === undefined ? base : { ...base, absDucats };
}

describe("barsForKey abs line", () => {
  it("carries the balance line in from an entry older than the window", () => {
    const hist = [entry(dayStr(-10), 10), entry(dayStr(-2), 10)];
    const res = barsForKey("ducatsDelta", hist, 7);

    expect(res.hasAbsData).toBe(true);
    expect(res.absLine).not.toBeNull();
    // Line spans the whole window, not just from the first in-window entry.
    expect(res.absLine![0].idx).toBe(0);
    expect(res.absLine!.length).toBe(res.bars.length);
    expect(res.absValues[0]).toBe(10);
  });

  it("starts the line at the first entry when no older data exists", () => {
    const hist = [entry(dayStr(-2), 10)];
    const res = barsForKey("ducatsDelta", hist, 7);

    expect(res.absLine).not.toBeNull();
    expect(res.absLine![0].idx).toBeGreaterThan(0);
    expect(Number.isNaN(res.absValues[0])).toBe(true);
  });
});
