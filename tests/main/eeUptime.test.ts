import { describe, expect, it } from "vitest";

import { EeUptimeTracker } from "../../services/eeUptime";

const line = (uptimeSec: string, text = "Sys [Info]: something") => `${uptimeSec} ${text}`;

describe("EeUptimeTracker", () => {
  it("reports ~0 staleness while lines arrive promptly", () => {
    const t = new EeUptimeTracker();
    expect(t.observe(line("100.000"), 1_000_100_000)).toBe(0);
    expect(t.observe(line("101.000"), 1_000_101_050)).toBe(50);
  });

  it("measures a delayed flush batch against the tightest offset seen", () => {
    const t = new EeUptimeTracker();
    t.observe(line("100.000"), 1_000_100_000); // tight anchor
    // Line generated at uptime 110s but flushed 10s late.
    expect(t.observe(line("110.000"), 1_000_120_000)).toBe(10_000);
  });

  it("unstamped lines inherit the batch staleness", () => {
    const t = new EeUptimeTracker();
    t.observe(line("100.000"), 1_000_100_000);
    t.observe(line("110.000"), 1_000_120_000);
    expect(t.observe('    "activeMissionTag" : "VoidT2",', 1_000_120_001)).toBe(10_000);
  });

  it("resets the offset when the game restarts (uptime regresses)", () => {
    const t = new EeUptimeTracker();
    t.observe(line("5000.000"), 1_000_000_000);
    // New game session: uptime starts over; offset must rebuild, not report
    // a huge negative-clamped or bogus staleness.
    expect(t.observe(line("10.000"), 1_000_300_000)).toBe(0);
    expect(t.observe(line("11.000"), 1_000_301_000)).toBe(0);
  });
});
