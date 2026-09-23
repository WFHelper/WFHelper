import { describe, it, expect } from "vitest";
import { DebugLineGate } from "../../services/debugLineFilter";

const RELIC_LINE = "Script [Info]: ThemedProjectionManager.lua: LoadingCompleteEnd";
const RELIC_FALLBACK = "Script [Info]: ThemedProjectionManager.lua: PopulateInventoryGrid";
const CHAT_LINE = "Sys [Info]: ChatRedux::AddTab: Adding tab with channel name: FUser to index 3";
const REWARD_LINE = "Sys [Info]: Pause countdown done";
const LOGIN_LINE = "Script [Info]: ThemedMainMenu.lua: MainMenu::LoginDone result=true";

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

  it("forwards the reward-UI render signal line", () => {
    const gate = new DebugLineGate();
    expect(gate.wants("Script [Info]: ProjectionRewardChoice.lua: Missing icon data!", 0)).toBe(
      true,
    );
  });

  it("forwards completed login lines", () => {
    const gate = new DebugLineGate();
    expect(gate.wants(LOGIN_LINE, 0)).toBe(true);
  });

  it("forwards the mission end, abort and mission info lines", () => {
    const gate = new DebugLineGate();
    for (const line of [
      "Sys [Info]: EOM missionLocationUnlocked=1",
      "Script [Info]: TopMenu.lua: Abort: mission failed",
      "Sys [Info]: SyncAutoPopulatedConsumables for mission MT_SURVIVAL with location SolNode25",
      "Game [Info]: OnStateStarted, mission type=MT_CAPTURE",
    ]) {
      expect(gate.wants(line, 0), line).toBe(true);
    }
  });

  it("forwards only weapon resource loads inside a riven view window", () => {
    const gate = new DebugLineGate();
    const weaponLoad =
      "Sys [Info]: ResourceLoader 0x1234 (/Lotus/Weapons/Tenno/Shotgun/PrimeBoar) Found 1,081 items to load";

    expect(gate.wants(weaponLoad, 900)).toBe(false);
    expect(gate.wants("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1", 1000)).toBe(true);
    expect(gate.wants(weaponLoad, 1100)).toBe(true);
    expect(
      gate.wants(
        "Sys [Info]: ResourceLoader 0x1234 (/Lotus/Levels/Episodes/SmallBlackRoom.level) Found 22 items to load",
        1200,
      ),
    ).toBe(false);
    expect(gate.wants(weaponLoad, 3000)).toBe(false);
  });
});
