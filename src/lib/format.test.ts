import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cycleTimeDisplay,
  formatNumber,
  formatTimeRemaining,
  nextDailyResetUtc,
  nextWeeklyResetUtc,
  parseIsoDate,
  timeTo,
  timeToStrict,
} from "./format.js";

describe("format helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses ISO dates safely", () => {
    expect(parseIsoDate("2026-03-02T10:30:00Z")?.toISOString()).toBe(
      "2026-03-02T10:30:00.000Z",
    );
    expect(parseIsoDate("not-a-date")).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it("formats countdown strings", () => {
    const target = new Date(Date.now() + (2 * 3600 + 5 * 60 + 9) * 1000);
    expect(timeTo(target)).toBe("2h 5m 9s");
    expect(timeToStrict(target)).toBe("2h 5m 9s");

    const shortTarget = new Date(Date.now() + (8 * 60 + 30) * 1000);
    expect(timeToStrict(shortTarget)).toBe("8m 30s");
  });

  it("formats compact numeric values", () => {
    expect(formatNumber(950)).toBe("950");
    expect(formatNumber(1_500)).toBe("1.5K");
    expect(formatNumber(2_200_000)).toBe("2.2M");
  });

  it("formats remaining duration for foundry cards", () => {
    const end = new Date(Date.now() + (49 * 3600 + 10 * 60) * 1000);
    expect(formatTimeRemaining(end)).toBe("2d 1h");
  });

  it("computes daily and weekly UTC reset boundaries", () => {
    const now = new Date("2026-03-04T12:34:56Z"); // Wednesday
    expect(nextDailyResetUtc(now).toISOString()).toBe("2026-03-05T00:00:00.000Z");
    expect(nextWeeklyResetUtc(now).toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("prefers API cycle time when non-zero and falls back otherwise", () => {
    expect(cycleTimeDisplay("1h 22m", "2026-03-03T00:00:00Z")).toBe("1h 22m");

    const fallback = cycleTimeDisplay("0m 0s", "2026-03-02T01:00:00Z");
    expect(fallback).toBe("1h 0m 0s");
  });
});

