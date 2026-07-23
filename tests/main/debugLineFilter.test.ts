import { describe, it, expect } from "vitest";
import { DebugLineGate } from "../../services/debugLineFilter";

const RELIC_LINE = "Script [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd";
const RELIC_FALLBACK = "Script [Info]: ThemedProjectionManager.lua: PopulateInventoryGrid";
const CHAT_LINE = "Sys [Info]: ChatRedux::AddTab: Adding tab with channel name: FUser to index 3";
const REWARD_LINE = "Sys [Info]: Pause countdown done";

describe("DebugLineGate", () => {
  it("drops lines that match no trigger substring", () => {
    const gate = new DebugLineGate();
    expect(gate.wants("Sys [Info]: some unrelated engine noise", 0)).toBe(false);
  });

  it("matches trigger substrings case-insensitively", () => {
    const gate = new DebugLineGate();
    expect(gate.wants(REWARD_LINE.toUpperCase(), 0)).toBe(true);
  });

  it("suppresses relic-line repeats within the cooldown window", () => {
    const gate = new DebugLineGate();
    expect(gate.wants(RELIC_LINE, 1000)).toBe(true);
    expect(gate.wants(RELIC_LINE, 2000)).toBe(false);
    // Fallback trigger shares the same suppression window
    expect(gate.wants(RELIC_FALLBACK, 8000)).toBe(false);
    expect(gate.wants(RELIC_LINE, 1000 + 7500)).toBe(true);
  });

  it("suppresses chat tab repeats within its own shorter window", () => {
    const gate = new DebugLineGate();
    expect(gate.wants(CHAT_LINE, 1000)).toBe(true);
    expect(gate.wants(CHAT_LINE, 2500)).toBe(false);
    expect(gate.wants(CHAT_LINE, 1000 + 2000)).toBe(true);
  });

  it("does not suppress non-relic trigger lines", () => {
    const gate = new DebugLineGate();
    expect(gate.wants(REWARD_LINE, 1000)).toBe(true);
    expect(gate.wants(REWARD_LINE, 1001)).toBe(true);
  });
});
