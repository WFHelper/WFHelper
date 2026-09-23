import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RIVEN_PATTERNS } from "../../services/eeLogMonitor";
import {
  processRivenPatterns,
  resetRivenState,
  resumeRivenSession,
  setRivenCallbacks,
} from "../../services/rivenLogStateMachine";
import {
  looksLikeStaleCardRead,
  parseRivenStats,
  rollRescanReason,
  type RivenStat,
} from "../../ipc/overlay/rivenScanText";
import { findWeaponInText, getWeaponNameByUniqueName } from "../../services/rivenData";

const rivenOverlayIpcSource = fs.readFileSync(
  path.join(process.cwd(), "ipc/rivenOverlayIpc.ts"),
  "utf8",
);

describe("riven overlay startup", () => {
  it("shows both panels before starting the initial scan", () => {
    const sessionOpen =
      rivenOverlayIpcSource.match(
        /export function onRivenSessionOpen\(\): void \{([\s\S]*?)\n\}/,
      )?.[1] ?? "";
    expect(sessionOpen).toMatch(
      /createRivenOverlayWindows\(\{ show: true \}\)[\s\S]*?triggerInitialScan\(\)/,
    );
    expect(sessionOpen).not.toContain("show: false");
  });

  it("re-reads the card in place instead of restarting the session on the hotkey", () => {
    const rescan =
      rivenOverlayIpcSource.match(/export function onRivenManualRescan\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(rescan).toMatch(/isAnyRivenWindowVisible\(\)[\s\S]*?rescanVisibleRivenCard\(\)/);
    expect(rescan).toMatch(/rescanVisibleRivenCard\(\);\n\s*return;/);
  });

  it("shares one rescan body between the hotkey and the overlay button", () => {
    const body =
      rivenOverlayIpcSource.match(
        /function rescanVisibleRivenCard\(\): void \{([\s\S]*?)\n\}/,
      )?.[1] ?? "";
    expect(body).toContain("sendToRivenWindows(RIVEN_RESCAN)");
    expect(body).not.toContain("startSession");
  });

  it("reuses keep-mapped panels instead of rebuilding them on reopen", () => {
    // A rebuild re-maps the window, and every native-Wayland map steals focus
    // from the game, which is the whole reason keep-mapped mode exists.
    const createFn =
      rivenOverlayIpcSource.match(/function createRivenOverlayWindows\([\s\S]*?\n\}\n/)?.[0] ?? "";
    expect(createFn).toContain("isKeepMappedActive()");
    expect(createFn).toMatch(/!keepMapped &&[\s\S]*?existLeft\.destroy\(\)/);
  });

  it("routes renderer-ready through the controller so first-load zoom applies", () => {
    // Riven replays its own events, so without this call the controller's
    // markRendererReady never runs and the zoom the navigation commit reset
    // stays at 1.0 on displays with a non-1 base zoom.
    const readyFn =
      rivenOverlayIpcSource.match(/export function markRivenRendererReady\([\s\S]*?\n\}/)?.[0] ??
      "";
    expect(readyFn).toContain("entry.controller.markRendererReady(senderId)");
  });
});

describe("RIVEN_PATTERNS", () => {
  describe("sessionOpen", () => {
    it("matches OmegaRerollSelection.swf creation line", () => {
      const line =
        "Sys [Info]: Created /Lotus/Interface/OmegaRerollSelection.swf @ 0x12345678 of class OmegaRerollSelectionScreen";
      expect(RIVEN_PATTERNS.sessionOpen.test(line)).toBe(true);
    });

    it("does not match other SWF lines", () => {
      expect(
        RIVEN_PATTERNS.sessionOpen.test("Sys [Info]: Created /Lotus/Interface/SomeOther.swf"),
      ).toBe(false);
    });
  });

  describe("cycleConfirmEn", () => {
    it("captures weapon name and cost from cycle dialog", () => {
      const line =
        "Dialog::CreateOkCancel(description=Are you sure you want to cycle Arca Plasmor for 4,000?, ...)";
      const m = line.match(RIVEN_PATTERNS.cycleConfirmEn);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("Arca Plasmor");
      expect(m![2].trim()).toBe("4,000");
    });

    it("captures weapon name with spaces", () => {
      const line =
        "Dialog::CreateOkCancel(description=Are you sure you want to cycle Vectis Prime for 9,600?, ...)";
      const m = line.match(RIVEN_PATTERNS.cycleConfirmEn);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("Vectis Prime");
    });

    it("handles period as thousands separator (EU locale)", () => {
      const line =
        "Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=Are you sure you want to cycle Burston Sati-critades for 3.500?, leftItem=/Menu/Confirm_Item_Yes, rightItem=/Menu/Confirm_Item_No)";
      const m = line.match(RIVEN_PATTERNS.cycleConfirmEn);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("Burston Sati-critades");
      expect(m![2].trim()).toBe("3.500");
    });

    it("does not match the choice confirm dialog", () => {
      const line = "Dialog::CreateOkCancel(description=Cycle Riven into current selection?, ...)";
      expect(RIVEN_PATTERNS.cycleConfirmEn.test(line)).toBe(false);
    });
  });

  describe("choiceConfirmEn", () => {
    it("matches the keep/reroll choice dialog (English)", () => {
      const line = "Dialog::CreateOkCancel(description=Cycle Riven into current selection?, ...)";
      expect(RIVEN_PATTERNS.choiceConfirmEn.test(line)).toBe(true);
    });

    it("does not match the cycle confirm dialog", () => {
      const line =
        "Dialog::CreateOkCancel(description=Are you sure you want to cycle Tigris Prime for 4,000?, ...)";
      expect(RIVEN_PATTERNS.choiceConfirmEn.test(line)).toBe(false);
    });
  });

  describe("genericDialog", () => {
    it("matches any CreateOkCancel dialog", () => {
      expect(
        RIVEN_PATTERNS.genericDialog.test(
          "Dialog::CreateOkCancel(description=Are you sure you want to cycle Arca Plasmor for 4,000?, ...)",
        ),
      ).toBe(true);
    });

    it("matches non-English dialog text", () => {
      expect(
        RIVEN_PATTERNS.genericDialog.test(
          "Dialog::CreateOkCancel(description=Möchtest du Arca Plasmor wirklich für 4.000 verändern?, ...)",
        ),
      ).toBe(true);
    });

    it("does not match SendResult", () => {
      expect(RIVEN_PATTERNS.genericDialog.test("Dialog.lua: Dialog::SendResult(4)")).toBe(false);
    });
  });

  describe("genericDialogNonInteractive", () => {
    it("matches NavBar_QuickMatchPleaseWait dialog (leftItem=nil)", () => {
      const line =
        "Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=/Lotus/Language/Menu/NavBar_QuickMatchPleaseWait, leftItem=nil, rightItem=nil)";
      expect(RIVEN_PATTERNS.genericDialogNonInteractive.test(line)).toBe(true);
    });

    it("does not match interactive riven dialogs", () => {
      const line =
        "Dialog::CreateOkCancel(description=Cycle Riven into current selection?, leftItem=/Menu/Confirm_Item_Yes, rightItem=/Menu/Confirm_Item_No)";
      expect(RIVEN_PATTERNS.genericDialogNonInteractive.test(line)).toBe(false);
    });
  });

  describe("sendResult", () => {
    it("captures result code 4 (confirm)", () => {
      const m = "Dialog.lua: Dialog::SendResult(4)".match(RIVEN_PATTERNS.sendResult);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("4");
    });

    it("captures result code 5 (cancel)", () => {
      const m = "Dialog.lua: Dialog::SendResult(5)".match(RIVEN_PATTERNS.sendResult);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("5");
    });

    it("matches Dialog::SendResult with any number", () => {
      expect(RIVEN_PATTERNS.sendResult.test("Dialog.lua: Dialog::SendResult(0)")).toBe(true);
      expect(RIVEN_PATTERNS.sendResult.test("Dialog.lua: Dialog::SendResult(99)")).toBe(true);
    });

    it("does not match unrelated lines", () => {
      expect(RIVEN_PATTERNS.sendResult.test("Some other log line")).toBe(false);
    });
  });

  describe("sessionClose", () => {
    it("matches NpcManager::ClearAgents line", () => {
      const line = "NpcManager::ClearAgents() ReadyToCreateAgents = false";
      expect(RIVEN_PATTERNS.sessionClose.test(line)).toBe(true);
    });

    it("does not match ReadyToCreateAgents = true", () => {
      expect(
        RIVEN_PATTERNS.sessionClose.test("NpcManager::ClearAgents() ReadyToCreateAgents = true"),
      ).toBe(false);
    });
  });

  describe("hudVis", () => {
    it("matches HudVis with any number", () => {
      const line = "ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1";
      const m = RIVEN_PATTERNS.hudVis.exec(line);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("1");
    });

    it("matches HudVis 0", () => {
      const m = RIVEN_PATTERNS.hudVis.exec("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 0");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("0");
    });

    it("extracts higher HudVis numbers", () => {
      const m = RIVEN_PATTERNS.hudVis.exec("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 3");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("3");
    });
  });

  describe("populateRiven", () => {
    it("matches PopulateInfo with Randomized mod path", () => {
      const line =
        "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusArchgunRandomMod";
      expect(RIVEN_PATTERNS.populateRiven.test(line)).toBe(true);
    });

    it("does not match PopulateInfo with non-riven path", () => {
      expect(
        RIVEN_PATTERNS.populateRiven.test(
          "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Weapons/Tenno/Melee",
        ),
      ).toBe(false);
    });
  });
});

describe("chat riven HudVis lifecycle", () => {
  afterEach(() => {
    resetRivenState();
    vi.useRealTimers();
  });

  it("stays open through nested HudVis changes and closes below its opening level", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const onRivenChatView = vi.fn();
    const onRivenSessionClose = vi.fn();
    setRivenCallbacks({ onRivenChatView, onRivenSessionClose });

    const process = (line: string) => processRivenPatterns(line, "dbwin", true);
    const hudVis = (level: number) => `ThemedDetailedPurchaseDialog.lua: DBG: HudVis ${level}`;
    const populate =
      "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusRifleRandomMod";

    process(hudVis(1));
    process(populate);
    expect(onRivenChatView).toHaveBeenCalledTimes(1);

    process(hudVis(2));
    process(hudVis(1));
    expect(onRivenSessionClose).not.toHaveBeenCalled();

    process(hudVis(0));
    expect(onRivenSessionClose).toHaveBeenCalledTimes(1);

    process(populate);
    expect(onRivenChatView).toHaveBeenCalledTimes(1);

    process(hudVis(1));
    process(populate);
    expect(onRivenChatView).toHaveBeenCalledTimes(2);
  });

  it("ignores delayed file echoes while DBWIN owns the chat lifecycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const onRivenChatView = vi.fn();
    const onRivenSessionClose = vi.fn();
    setRivenCallbacks({ onRivenChatView, onRivenSessionClose });

    const hudVis = (level: number) => `ThemedDetailedPurchaseDialog.lua: DBG: HudVis ${level}`;
    const populate =
      "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusRifleRandomMod";
    const dbwin = (line: string) => processRivenPatterns(line, "dbwin", true);
    const file = (line: string) => processRivenPatterns(line, "file", true);

    dbwin(hudVis(1));
    dbwin(populate);
    dbwin(hudVis(0));
    expect(onRivenSessionClose).toHaveBeenCalledTimes(1);

    dbwin(hudVis(1));
    dbwin(populate);
    expect(onRivenChatView).toHaveBeenCalledTimes(2);

    file(hudVis(0));
    expect(onRivenSessionClose).toHaveBeenCalledTimes(1);

    dbwin(hudVis(0));
    expect(onRivenSessionClose).toHaveBeenCalledTimes(2);

    file(hudVis(1));
    file(populate);
    expect(onRivenChatView).toHaveBeenCalledTimes(2);
  });

  it("uses file chat events when no real-time source is active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const onRivenChatView = vi.fn();
    const onRivenSessionClose = vi.fn();
    const onRivenWeaponPath = vi.fn();
    setRivenCallbacks({ onRivenChatView, onRivenSessionClose, onRivenWeaponPath });

    const process = (line: string) => processRivenPatterns(line, "file", false);
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1");
    process(
      "Sys [Info]: ResourceLoader 0x1234 (/Lotus/Weapons/Tenno/Shotgun/PrimeBoar) Found 1,081 items to load",
    );
    process(
      "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusRifleRandomMod",
    );
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 0");

    expect(onRivenChatView).toHaveBeenCalledTimes(1);
    expect(onRivenWeaponPath).toHaveBeenCalledWith("/Lotus/Weapons/Tenno/Shotgun/PrimeBoar");
    expect(onRivenSessionClose).toHaveBeenCalledTimes(1);
  });

  it("delivers the exact linked weapon path after opening the chat view", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const events: string[] = [];
    setRivenCallbacks({
      onRivenChatView: () => events.push("chat"),
      onRivenWeaponPath: (weaponPath) => events.push(weaponPath),
    });

    const process = (line: string) => processRivenPatterns(line, "dbwin", true);
    process("530.304 Script [Info]: ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1");
    process(
      "530.357 Sys [Info]: ResourceLoader 0x000001ABBE845340 (/Lotus/Weapons/Tenno/Shotgun/PrimeBoar) Found 1,081 items to load",
    );
    expect(events).toEqual([]);

    process(
      "530.415 Script [Info]: ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusShotgunRandomModRare",
    );
    expect(events).toEqual(["chat", "/Lotus/Weapons/Tenno/Shotgun/PrimeBoar"]);
  });

  it("discards a linked weapon path when the view closes before confirmation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const events: string[] = [];
    setRivenCallbacks({
      onRivenChatView: () => events.push("chat"),
      onRivenWeaponPath: (weaponPath) => events.push(weaponPath),
    });

    const process = (line: string) => processRivenPatterns(line, "dbwin", true);
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1");
    process(
      "Sys [Info]: ResourceLoader 0x1234 (/Lotus/Weapons/Tenno/Shotgun/PrimeBoar) Found 1,081 items to load",
    );
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 0");
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1");
    process(
      "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusShotgunRandomModRare",
    );

    expect(events).toEqual(["chat"]);
  });

  it("discards a linked weapon path when its HudVis window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    resetRivenState();

    const events: string[] = [];
    setRivenCallbacks({
      onRivenChatView: () => events.push("chat"),
      onRivenWeaponPath: (weaponPath) => events.push(weaponPath),
    });

    const process = (line: string) => processRivenPatterns(line, "dbwin", true);
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1");
    process(
      "Sys [Info]: ResourceLoader 0x1234 (/Lotus/Weapons/Tenno/Shotgun/PrimeBoar) Found 1,081 items to load",
    );
    vi.advanceTimersByTime(2100);
    process("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 2");
    process(
      "ThemedDetailedPurchaseDialog.lua: PopulateInfo->/Lotus/StoreItems/Upgrades/Mods/Randomized/LotusShotgunRandomModRare",
    );

    expect(events).toEqual(["chat"]);
  });
});

describe("parseRivenStats", () => {
  it("returns empty array for empty input", () => {
    expect(parseRivenStats("")).toEqual([]);
    expect(parseRivenStats("  ")).toEqual([]);
  });

  it("recognises a positive stat with value", () => {
    const result = parseRivenStats("+48.3% Critical Chance");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
    expect(result[0].positive).toBe(true);
    expect(result[0].value).toBe(48.3);
  });

  it("recognises a negative stat with em-dash and value", () => {
    const result = parseRivenStats("\u201394.5% Recoil");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Recoil");
    // Recoil is an inverted-polarity stat: minus on screen = beneficial
    expect(result[0].positive).toBe(true);
    expect(result[0].displayPositive).toBe(false);
    expect(result[0].value).toBe(94.5);
  });

  it("recognises a negative stat with hyphen-minus and value", () => {
    const result = parseRivenStats("-27.3% Zoom");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Zoom");
    expect(result[0].positive).toBe(false);
    expect(result[0].displayPositive).toBeUndefined();
    expect(result[0].value).toBe(27.3);
  });

  it("keeps a minus-signed Zoom a curse despite OCR prefix garbage", () => {
    const result = parseRivenStats("o -29.8% Zoom");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Zoom", positive: false, value: 29.8 });
  });

  it("keeps inverted-polarity stat display signs from OCR while preserving beneficial semantics", () => {
    const result = parseRivenStats("-66,2% Weapon Recoil");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "Weapon Recoil",
      positive: true,
      displayPositive: false,
      value: 66.2,
    });
  });

  it("normalises locale comma decimal separator", () => {
    const result = parseRivenStats("+94,5% Critical Chance");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
    expect(result[0].value).toBe(94.5);
  });

  it("parses multiple stats from multi-line OCR text", () => {
    const text = [
      "+48.3% Critical Chance",
      "+127.2% Critical Damage",
      "-27.3% Zoom",
      "+15.5% Multishot",
    ].join("\n");
    const result = parseRivenStats(text);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.name)).toEqual([
      "Critical Chance",
      "Critical Damage",
      "Zoom",
      "Multishot",
    ]);
    expect(result.map((s) => s.positive)).toEqual([true, true, false, true]);
    expect(result.map((s) => s.value)).toEqual([48.3, 127.2, 27.3, 15.5]);
  });

  it("recovers a wrapped, garbled Additional Combo Count Chance line", () => {
    // Real PaddleOCR output (2026-08-03 report): the card wraps the stat name
    // across two lines and garbles "Additional" into "Aal".
    const text = [
      "+69.3% Aal Combo",
      ". Count Chance",
      "+190.2% Melee Damage",
      ": +95.8% WHeat 5",
      "MR1624",
    ].join("\n");
    const result = parseRivenStats(text);
    expect(result.map((s) => s.name)).toEqual([
      "Additional Combo Count Chance",
      "Melee Damage",
      "Heat",
    ]);
    expect(result.map((s) => s.value)).toEqual([69.3, 190.2, 95.8]);
    expect(result.every((s) => s.positive)).toBe(true);
  });

  it("reports signed lines that parse to nothing via diagnostics", () => {
    const diagnostics = { droppedLines: [] as string[] };
    const result = parseRivenStats(
      "+48.3% Critical Chance\n+12.3% Xyzqgarbleword\nMR1624",
      diagnostics,
    );
    expect(result).toHaveLength(1);
    expect(diagnostics.droppedLines).toEqual(["+12.3% Xyzqgarbleword"]);
  });

  it("completes a bare Combo Count Chance tail to the full stat name", () => {
    const result = parseRivenStats("+61.2% Combo Count Chance");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Additional Combo Count Chance");
    expect(result[0].value).toBe(61.2);
  });

  it("ignores unrecognised lines", () => {
    const text = "SomeGarbage\n+48.3% Critical Chance\nMoreGarbage\nWeirdText";
    const result = parseRivenStats(text);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
    expect(result[0].value).toBe(48.3);
  });

  it("is case-insensitive for stat names", () => {
    const result = parseRivenStats("+48% critical chance");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
    expect(result[0].value).toBe(48);
  });

  it("recognises all major damage types", () => {
    const text = ["Cold", "Heat", "Electricity", "Toxin", "Radiation", "Viral"].join("\n");
    const result = parseRivenStats(text);
    expect(result).toHaveLength(6);
    // No sign/value -> positive=true, value=null
    for (const stat of result) {
      expect(stat.positive).toBe(true);
      expect(stat.value).toBeNull();
    }
  });

  it("extracts all stats from a single merged OCR line", () => {
    const text =
      "18 Burston Sati-critades +1 90,9% Critical Chance Status Duration +1 Multishot -89,8% Status Chance";
    const result = parseRivenStats(text);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.name)).toEqual([
      "Critical Chance",
      "Status Duration",
      "Multishot",
      "Status Chance",
    ]);
    expect(result[0].positive).toBe(true);
    expect(result[1].positive).toBe(true);
    expect(result[2].positive).toBe(true);
    expect(result[3].positive).toBe(false);
    // Value for Critical Chance: prefix "+1 90,9%" -> collapse spaces -> "+190,9%" -> 190.9
    expect(result[0].value).toBe(190.9);
    expect(result[3].value).toBe(89.8);
  });

  it("ignores compound-name dashes when determining sign (Sati-critades)", () => {
    const text = "Burston Sati-critades Critical Chance";
    const result = parseRivenStats(text);
    expect(result).toHaveLength(1);
    expect(result[0].positive).toBe(true);
    expect(result[0].value).toBeNull();
  });

  it("handles x-multiplier format (e.g. x1,59 Damage to Infested)", () => {
    const text = "+173,5% Slash x1,59 Damage to Infested";
    const result = parseRivenStats(text);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Slash");
    expect(result[0].value).toBe(173.5);
    expect(result[0].positive).toBe(true);
    expect(result[0].multiplier).toBeFalsy();
    expect(result[1].name).toBe("Damage to Infested");
    expect(result[1].value).toBe(1.59);
    expect(result[1].positive).toBe(true);
    expect(result[1].multiplier).toBe(true);
  });

  it("deduplicates the same stat appearing on multiple lines", () => {
    const text = "+48.3% Critical Chance\n+48.3% Critical Chance";
    const result = parseRivenStats(text);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(48.3);
  });

  it("recognises melee-specific stats", () => {
    const text = ["+50.2% Attack Speed", "+120% Range", "-30% Combo Duration"].join("\n");
    const result = parseRivenStats(text);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual(["Attack Speed", "Range", "Combo Duration"]);
    expect(result[0].value).toBe(50.2);
    expect(result[1].value).toBe(120);
    expect(result[2].value).toBe(30);
    expect(result[2].positive).toBe(false);
  });

  it("extracts value from sign+number without percent sign", () => {
    // Sometimes OCR misses the % sign
    const result = parseRivenStats("+190 Critical Chance");
    expect(result).toHaveLength(1);
    expect(result[0].positive).toBe(true);
    expect(result[0].value).toBe(190);
  });

  it("handles space between sign and value", () => {
    const result = parseRivenStats("+ 48.3% Critical Chance");
    expect(result).toHaveLength(1);
    expect(result[0].positive).toBe(true);
    expect(result[0].value).toBe(48.3);
  });

  it("returns value=null when no numeric value present", () => {
    const result = parseRivenStats("Critical Chance");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
    expect(result[0].positive).toBe(true);
    expect(result[0].value).toBeNull();
  });

  it("sanitises unreasonably large values (dropped decimal: 1552 -> 155.2)", () => {
    const result = parseRivenStats("+1552% Critical Damage");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(155.2);
    expect(result[0].positive).toBe(true);
  });

  it("sanitises 739 -> 73.9 (dropped comma)", () => {
    const result = parseRivenStats("-739% Slash");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(73.9);
    expect(result[0].positive).toBe(false);
  });

  it("does not sanitise values under 500", () => {
    const result = parseRivenStats("+219.5% Damage");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(219.5);
  });

  it("recovers decimal when OCR reads comma as space (73 9%)", () => {
    const result = parseRivenStats("-73 9% Slash");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(73.9);
  });

  it("recovers decimal in 165 4% -> 165.4%", () => {
    const result = parseRivenStats("-165 4% Recoil");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(165.4);
  });

  it("fixes WinRT ( misread of x prefix for fractional multipliers (0.xx)", () => {
    const result = parseRivenStats("(0,59 Damage to Corpus +42.2% Attack Speed");
    const corpus = result.find((s) => s.name === "Damage to Corpus");
    expect(corpus).toBeDefined();
    expect(corpus?.value).toBeCloseTo(0.59, 2);
  });

  it("fixes WinRT ( misread of x prefix for multipliers > 1 (1.xx)", () => {
    const result = parseRivenStats("(1,38 Damage to Corpus +42.2% Attack Speed");
    const corpus = result.find((s) => s.name === "Damage to Corpus");
    expect(corpus).toBeDefined();
    expect(corpus?.value).toBeCloseTo(1.38, 2);
  });

  it("recognises Melee Damage stat", () => {
    const result = parseRivenStats("+177.1% Melee Damage");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Melee Damage");
    expect(result[0].value).toBe(177.1);
  });

  it("recognises Finisher Damage stat", () => {
    const result = parseRivenStats("+131.5% Finisher Damage");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Finisher Damage");
    expect(result[0].value).toBe(131.5);
  });

  it("prefers Melee Damage over bare Damage when both match", () => {
    const result = parseRivenStats("+177.1% Melee Damage\n+85.1% Critical Damage");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Melee Damage");
    expect(result[1].name).toBe("Critical Damage");
  });

  it("strips (x2 for Heavy Attacks) qualifier - not a separate stat", () => {
    const text = "+185,5% Critical Chance\n(x2 for Heavy Attacks)\n+8,5s Combo Duration";
    const result = parseRivenStats(text);
    // Should have Critical Chance + Combo Duration, NOT Heavy Attack
    const names = result.map((s) => s.name);
    expect(names).toContain("Critical Chance");
    expect(names).toContain("Combo Duration");
    expect(names).not.toContain("Heavy Attack");
  });

  it("strips seconds suffix from Combo Duration (8,5s -> 8.5)", () => {
    const result = parseRivenStats("+8,5s Combo Duration");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Combo Duration");
    expect(result[0].value).toBe(8.5);
  });

  it("rejoins Critical Chance for Slide Attack split across lines", () => {
    const text = "+128,1% Critical Chance\nfor Slide Attack\n+157% Melee Damage";
    const result = parseRivenStats(text);
    const names = result.map((s) => s.name);
    expect(names).toContain("Critical Chance for Slide Attack");
    expect(names).toContain("Melee Damage");
    expect(names).not.toContain("Slide");
    const ccStat = result.find((s) => s.name === "Critical Chance for Slide Attack");
    expect(ccStat!.value).toBe(128.1);
  });

  it("rejoins Critical Chance for Slide Attack with OCR noise between fragments", () => {
    // Real OCR output: "Critical Chance -\n- 4 for Slide Attack"
    const text = "+128,1% Critical Chance -\n- 4 for Slide Attack\n+157% Melee Damage";
    const result = parseRivenStats(text);
    const names = result.map((s) => s.name);
    expect(names).toContain("Critical Chance for Slide Attack");
    expect(names).toContain("Melee Damage");
    expect(names).not.toContain("Slide");
    const ccStat = result.find((s) => s.name === "Critical Chance for Slide Attack");
    expect(ccStat!.value).toBe(128.1);
  });

  it("parses full riven card: Melee Damage + Critical Chance (x2) + Combo Duration + x-mult", () => {
    // Simulates OCR output from screenshot 1
    const text =
      "+186,7% Melee Damage\n+185,5% Critical Chance\n(x2 for Heavy Attacks)\n+8,5s Combo Duration\nx0,62 Damage to Infested";
    const result = parseRivenStats(text);
    expect(result.length).toBeGreaterThanOrEqual(4);
    const names = result.map((s) => s.name);
    expect(names).toContain("Melee Damage");
    expect(names).toContain("Critical Chance");
    expect(names).toContain("Combo Duration");
    expect(names).toContain("Damage to Infested");
    expect(names).not.toContain("Heavy Attack");

    const combo = result.find((s) => s.name === "Combo Duration");
    expect(combo!.value).toBe(8.5);

    const dmgInf = result.find((s) => s.name === "Damage to Infested");
    expect(dmgInf!.value).toBe(0.62);
    expect(dmgInf!.multiplier).toBe(true);
  });

  it("parses Critical Chance for Slide Attack + negative Critical Chance on same card", () => {
    // Simulates screenshot 3 OCR
    const text =
      "+128,1% Critical Chance\nfor Slide Attack\n+157% Melee Damage\n+98,8% Heat\n-147,6% Critical Chance\n(x2 for Heavy Attacks)";
    const result = parseRivenStats(text);
    const names = result.map((s) => s.name);
    expect(names).toContain("Critical Chance for Slide Attack");
    expect(names).toContain("Melee Damage");
    expect(names).toContain("Heat");
    expect(names).toContain("Critical Chance");
    expect(names).not.toContain("Heavy Attack");

    const ccSlide = result.find((s) => s.name === "Critical Chance for Slide Attack");
    expect(ccSlide!.value).toBe(128.1);
    expect(ccSlide!.positive).toBe(true);

    const cc = result.find((s) => s.name === "Critical Chance");
    expect(cc!.value).toBe(147.6);
    expect(cc!.positive).toBe(false);
  });

  it("rejoins orphan numeric lines with the following stat line", () => {
    const text = [
      "+126,2% Status Duration",
      "+122,2%",
      "4 Electricity",
      "+112% Multishot",
      "x0,58 Damage to Grineer",
    ].join("\n");
    const result = parseRivenStats(text);
    expect(result.map((s) => [s.name, s.value])).toEqual([
      ["Status Duration", 126.2],
      ["Electricity", 122.2],
      ["Multishot", 112],
      ["Damage to Grineer", 0.58],
    ]);
  });

  it("pairs orphan value with stat name when noise line intervenes (Gelimantiton/Cold scenario)", () => {
    // WinRT can place the riven suffix between an orphan value and its stat name.
    const text = [
      "+95,50/0", // Cold value (+95.5%) - 0/0 is WinRT misread of %
      "Gelimantiton", // riven-name suffix injected as a stats-area line by WinRT
      "Cold",
      "+122,4% Impact",
      "x1,46 Damage to Corpus",
    ].join("\n");
    const result = parseRivenStats(text);
    const cold = result.find((s) => s.name === "Cold");
    const impact = result.find((s) => s.name === "Impact");
    const dtc = result.find((s) => s.name === "Damage to Corpus");
    expect(cold).toBeDefined();
    expect(cold!.value).toBe(95.5);
    expect(cold!.positive).toBe(true);
    expect(impact).toBeDefined();
    expect(impact!.value).toBe(122.4);
    expect(dtc).toBeDefined();
    expect(dtc!.value).toBeCloseTo(1.46, 2);
    expect(dtc!.multiplier).toBe(true);
  });

  it("FIFO: two consecutive value lines each pair with the following stat in order", () => {
    // Values and stat-names appear in two separate blocks: values first, then names.
    // FIFO ensures Cold gets +95.5 and Impact gets +122.4, not vice versa.
    const text = ["+95,5%", "+122,4%", "Cold", "Impact", "x1,46 Damage to Corpus"].join("\n");
    const result = parseRivenStats(text);
    const cold = result.find((s) => s.name === "Cold");
    const impact = result.find((s) => s.name === "Impact");
    expect(cold).toBeDefined();
    expect(cold!.value).toBe(95.5);
    expect(impact).toBeDefined();
    expect(impact!.value).toBe(122.4);
  });

  it("FIFO: does not steal orphan value from stat-name line that already has its own value", () => {
    const text = ["+180.7%", "+133.9%", "-1.1 Range"].join("\n");
    const result = parseRivenStats(text);
    const range = result.find((s) => s.name === "Range");
    expect(range).toBeDefined();
    expect(range!.value).toBe(1.1);
    expect(range!.positive).toBe(false);
    // orphan values have no stat name - expect only Range
    expect(result).toHaveLength(1);
  });

  it("does not carry-forward when icon-artifact dash present before element stat (Magnatox scenario)", () => {
    // Garbled icon text marks Toxin as a separate row, not a combined element.
    const text = "+180.7% Impact -ÔÇ×e Toxin -1.1 Range";
    const result = parseRivenStats(text);
    const impact = result.find((s) => s.name === "Impact");
    const toxin = result.find((s) => s.name === "Toxin");
    const range = result.find((s) => s.name === "Range");
    expect(impact).toBeDefined();
    expect(impact!.value).toBe(180.7);
    expect(toxin).toBeDefined();
    expect(toxin!.value).toBeNull(); // must NOT carry 180.7 from Impact
    expect(range).toBeDefined();
    expect(range!.value).toBe(1.1);
    expect(range!.positive).toBe(false);
  });

  it("does not carry-forward from non-damage-type stat (Status Duration + Electricity)", () => {
    // Status Duration and Electricity are separate stats despite the merged OCR line.
    const text = "+126.2% Status Duration + Electricity";
    const result = parseRivenStats(text);
    const sd = result.find((s) => s.name === "Status Duration");
    const elec = result.find((s) => s.name === "Electricity");
    expect(sd).toBeDefined();
    expect(sd!.value).toBe(126.2);
    expect(elec).toBeDefined();
    expect(elec!.value).toBeNull(); // separate stat, not combined element
    expect(elec!.positive).toBe(true);
  });

  it("carries forward between damage-type stats (Electricity + Impact combined element)", () => {
    // Combined element roll: "+112% Electricity Impact" - both are damage types.
    const text = "+112% Electricity Impact";
    const result = parseRivenStats(text);
    const elec = result.find((s) => s.name === "Electricity");
    const imp = result.find((s) => s.name === "Impact");
    expect(elec).toBeDefined();
    expect(elec!.value).toBe(112);
    expect(imp).toBeDefined();
    expect(imp!.value).toBe(112); // carry-forward from damage-type to damage-type
    expect(imp!.positive).toBe(true);
  });

  it("fixes spaced decimal point in OCR values (+151 .4% -> +151.4%)", () => {
    const text = "+2.5 Range\n+70.6% Attack Speed\n+151 .4% Impact\n-8.6 Combo Duration";
    const result = parseRivenStats(text);
    const impact = result.find((s) => s.name === "Impact");
    expect(impact).toBeDefined();
    expect(impact!.value).toBe(151.4);
    expect(impact!.positive).toBe(true);
  });

  it("fixes OCR misread xO->x0 in multiplier values (xO,58 Damage to Grineer)", () => {
    // OCR reads zero as letter O: "xO,58" instead of "x0,58"
    const text =
      "+126,2% Status Duration +122,2% f Electricity +112% Multishot xO,58 Damage to Grineer";
    const result = parseRivenStats(text);
    const dmg = result.find((s) => s.name === "Damage to Grineer");
    expect(dmg).toBeDefined();
    expect(dmg!.value).toBe(0.58);
    expect(dmg!.multiplier).toBe(true);
    expect(dmg!.positive).toBe(false);
  });

  it("fixes OCR misread xl->x1 in multiplier values (xl,56 Damage to Corpus)", () => {
    // WinRT OCR reads digit 1 as lowercase l: "xl,56" instead of "x1,56"
    const text = "+136,2% Impact +9,7s Combo Duration xl,56 Damage to Corpus -52,5% Attack Speed";
    const result = parseRivenStats(text);
    const dmg = result.find((s) => s.name === "Damage to Corpus");
    expect(dmg).toBeDefined();
    expect(dmg!.value).toBe(1.56);
    expect(dmg!.multiplier).toBe(true);
    expect(dmg!.positive).toBe(true);
  });

  it("fixes spaced multiplier misread 'x I , 44 Damage to Grineer' -> x1.44", () => {
    // WinRT OCR reads "x1,44" as "x I , 44" with spaces between each part
    const text = "+1,8 Range +109,1% Slash x I , 44 Damage to Grineer";
    const result = parseRivenStats(text);
    const dmg = result.find((s) => s.name === "Damage to Grineer");
    expect(dmg).toBeDefined();
    expect(dmg!.value).toBe(1.44);
    expect(dmg!.multiplier).toBe(true);
    expect(dmg!.positive).toBe(true);
  });

  it("fixes spaced multiplier 'x1 , 44' with space around comma", () => {
    const text = "x1 , 44 Damage to Grineer";
    const result = parseRivenStats(text);
    const dmg = result.find((s) => s.name === "Damage to Grineer");
    expect(dmg).toBeDefined();
    expect(dmg!.value).toBe(1.44);
    expect(dmg!.multiplier).toBe(true);
  });

  it("repairs PaddleOCR truncated faction multipliers from roll-choice cards", () => {
    const text = [
      "+115,9% Damage",
      "+74,1% 3:Toxin",
      "<1,32 Damage to Infeste",
      "x0,75 Damage to Corpu",
    ].join("\n");
    const result = parseRivenStats(text);

    expect(result.map((s) => s.name)).toEqual([
      "Damage",
      "Toxin",
      "Damage to Infested",
      "Damage to Corpus",
    ]);
    expect(result.find((s) => s.name === "Damage")?.value).toBe(115.9);
    expect(result.find((s) => s.name === "Toxin")?.value).toBe(74.1);

    const infested = result.find((s) => s.name === "Damage to Infested");
    expect(infested).toMatchObject({ value: 1.32, positive: true, multiplier: true });

    const corpus = result.find((s) => s.name === "Damage to Corpus");
    expect(corpus).toMatchObject({ value: 0.75, positive: false, multiplier: true });
  });

  it("rejoins Finisher\\nDamage split across lines (WinRT icon line-break)", () => {
    // WinRT OCR splits "Finisher Damage" across two lines: value is on the
    // same line as the first word; second word starts the next line.
    const text = "+144,9% Finisher\nDamage";
    const result = parseRivenStats(text);
    const fin = result.find((s) => s.name === "Finisher Damage");
    expect(fin).toBeDefined();
    expect(fin!.value).toBe(144.9);
    expect(fin!.positive).toBe(true);
  });

  it("rejoins Critical\\nChance split across lines", () => {
    const text = "+95,3% Critical\nChance";
    const result = parseRivenStats(text);
    const cc = result.find((s) => s.name === "Critical Chance");
    expect(cc).toBeDefined();
    expect(cc!.value).toBe(95.3);
  });

  it("rejoins Status\\nDuration split across lines", () => {
    const text = "+124% Status\nDuration";
    const result = parseRivenStats(text);
    const sd = result.find((s) => s.name === "Status Duration");
    expect(sd).toBeDefined();
    expect(sd!.value).toBe(124);
  });

  it("ignores junk glyphs before elemental stats", () => {
    const result = parseRivenStats("+122,2% ┬Ñ Electricity <");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Electricity");
    expect(result[0].value).toBe(122.2);
  });

  it("carries value to combined damage-type stat on same line (e.g. Electricity + Impact)", () => {
    // WinRT OCR reads "+112,3% 4 Electricity *Impact" - after icon stripping
    // "Impact" appears on the same sub-line as "Electricity" with no preceding value.
    const result = parseRivenStats(
      "+112,3% 4 Electricity *Impact +117,2% Critical Damage -53% Attack Speed",
    );
    const elec = result.find((s) => s.name === "Electricity");
    const imp = result.find((s) => s.name === "Impact");
    expect(elec).toBeDefined();
    expect(elec!.value).toBe(112.3);
    expect(imp).toBeDefined();
    expect(imp!.value).toBe(112.3);
    expect(imp!.positive).toBe(true);
  });

  it("carries value to Impact when appearing after Impact on same line", () => {
    const result = parseRivenStats(
      "+134,6% *Impact v Slash +119,2% Status Chance -106,2% Chance to Gain Combo Count",
    );
    const imp = result.find((s) => s.name === "Impact");
    const slash = result.find((s) => s.name === "Slash");
    expect(imp).toBeDefined();
    expect(imp!.value).toBe(134.6);
    expect(slash).toBeDefined();
    expect(slash!.value).toBe(134.6);
  });

  it("rejoins split x-multiplier decimal: WinRT splits 'x 1,3 Damage' into 'x 1' + ',3 Damage to Corpus'", () => {
    // An intervening icon can split the multiplier's integer and decimal parts.
    const text = "x 1\n,3 Damage to Corpus\nx 1,36 Damage to Grineer\n-68,4% Impact";
    const result = parseRivenStats(text);
    const corpus = result.find((s) => s.name === "Damage to Corpus");
    expect(corpus).toBeDefined();
    expect(corpus!.value).toBeCloseTo(1.3, 5);
    expect(corpus!.multiplier).toBe(true);
    const grineer = result.find((s) => s.name === "Damage to Grineer");
    expect(grineer).toBeDefined();
    expect(grineer!.value).toBeCloseTo(1.36, 5);
    expect(grineer!.multiplier).toBe(true);
  });

  it("does not carry-forward value from multiplier stat to elemental stat on same line", () => {
    // A merged multiplier must not supply the missing value of the following stat.
    const text = "x1.36 Damage to Grineer  Heat";
    const result = parseRivenStats(text);
    const grineer = result.find((s) => s.name === "Damage to Grineer");
    const heat = result.find((s) => s.name === "Heat");
    expect(grineer).toBeDefined();
    expect(grineer!.value).toBeCloseTo(1.36, 5);
    expect(grineer!.multiplier).toBe(true);
    expect(heat).toBeDefined();
    expect(heat!.value).toBeNull(); // must NOT inherit 1.36 from the multiplier stat
  });

  it("normalises spaced decimal comma in percent value: '+62, 2% Heat' -> 62.2", () => {
    // WinRT sometimes inserts a space after a decimal comma.
    const text = "x1.3 Damage to Corpus\nx1.36 Damage to Grineer\n+62, 2% Heat\n-68.4% Impact";
    const result = parseRivenStats(text);
    const heat = result.find((s) => s.name === "Heat");
    expect(heat).toBeDefined();
    expect(heat!.value).toBeCloseTo(62.2, 5);
    expect(heat!.positive).toBe(true);
  });

  it("orphan '+62,' (trailing comma) pairs with following stat name", () => {
    // A trailing comma still marks an orphan numeric fragment.
    const text = "+62,\nHeat";
    const result = parseRivenStats(text);
    const heat = result.find((s) => s.name === "Heat");
    expect(heat).toBeDefined();
    expect(heat!.positive).toBe(true);
    // Value is 62 (integer part of +62.2) - the orphan pairs the fragment with Heat
    expect(heat!.value).toBe(62);
  });

  it("deduplication prefers non-integer over integer value for same stat (xl vs x1.3)", () => {
    // Duplicate panels can yield x1 before the more precise x1.3 reading.
    const text = "xl Damage to Corpus\nx 1,3 Damage to Corpus";
    const result = parseRivenStats(text);
    // Only one "Damage to Corpus" entry
    const matches = result.filter((s) => s.name === "Damage to Corpus");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBeCloseTo(1.3, 5);
    expect(matches[0].multiplier).toBe(true);
  });

  it("deduplication does NOT replace when integer parts differ (value=2 vs value=62.2)", () => {
    // Precision replacement is safe only when both readings share an integer part.
    const text = "+2% Heat\n+62.2% Heat";
    const result = parseRivenStats(text);
    const matches = result.filter((s) => s.name === "Heat");
    expect(matches).toHaveLength(1);
    // First occurrence (value=2) is kept; second does not satisfy floor(62.2)=2
    expect(matches[0].value).toBe(2);
  });

  it("strips the '(x2 for Bows)' qualifier instead of parsing a phantom stat", () => {
    // The qualifier wraps and clips to "(x2 fol" + "Bows)", and "fol" is close
    // enough to fuzzy-match Cold.
    const text = [
      "Boar Satidra",
      "+211,9% Multishot",
      "+155,1% Fire Rate (x2 fol",
      "Bows)",
      "+65% Weapon Recoil",
      "MIOATO",
    ].join("\n");
    const result = parseRivenStats(text);
    expect(result.map((s) => s.name)).toEqual(["Multishot", "Fire Rate", "Weapon Recoil"]);
    expect(result.map((s) => s.value)).toEqual([211.9, 155.1, 65]);
    // "+65% Weapon Recoil" on screen is the curse direction (inverted polarity)
    expect(result[2].positive).toBe(false);
    expect(result[2].displayPositive).toBe(true);
  });

  it("strips an intact '(x2 for Bows)' qualifier split across lines", () => {
    const result = parseRivenStats("+155,1% Fire Rate (x2 for\nBows)");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Fire Rate", value: 155.1, positive: true });
  });

  it("rejects x-multiplier values on non-damage stats", () => {
    // Only faction damage rolls as an x-multiplier; a bare "x2 fol" fragment
    // must not fuzzy-complete into an element stat.
    const result = parseRivenStats("+100% Critical Chance\nx2 fol");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Critical Chance");
  });

  it("keeps a flat Range roll alongside percent stats (Dark Dagger case)", () => {
    const text = "+2,5 Range\n+84,9% Heavy Attack Efficiency\n-48,1% Status Chance";
    const result = parseRivenStats(text);
    expect(result.map((s) => s.name)).toEqual([
      "Range",
      "Heavy Attack Efficiency",
      "Status Chance",
    ]);
    expect(result.map((s) => s.value)).toEqual([2.5, 84.9, 48.1]);
  });
});

describe("findWeaponInText", () => {
  it("finds exact weapon names inside OCR text", () => {
    expect(findWeaponInText("Rubico Prime Crita-acrit\n+185.1% Critical Chance")).toBe(
      "Rubico Prime",
    );
  });

  it("recovers fuzzy weapon names from OCR title lines", () => {
    expect(findWeaponInText("Rubico Prine Crita-acrit\n+185.1% Critical Chance")).toBe(
      "Rubico Prime",
    );
  });

  it("supports Aleca-style alias fallback names", () => {
    expect(findWeaponInText("Gotva Visi-critata\n+198.2% Multishot")).toBe("Gotva Prime");
  });

  // A weapon missing from the bundled export must not fall through to the
  // generated suffix, which grades the wrong gun ("Hera-decipha" as Hema).
  // The export always lags a new weapon, so anchoring carries this, not a
  // version bump.
  it("never takes a weapon name out of the riven suffix", () => {
    expect(findWeaponInText("Grelvax Hera-decipha\n+50.3% Status Duration")).toBeNull();
    expect(findWeaponInText("Grelvax Lexi-gelitron\nx1.22 Damage to Corpus")).toBeNull();
    expect(findWeaponInText("Grelvax Boari-critacan\n+103.9% Damage")).toBeNull();
  });

  it("still resolves weapon names that lead the title line", () => {
    expect(findWeaponInText("Wolf Sledge Acri-\ncronitor\n+0.2 Range")).toBe("Wolf Sledge");
    expect(findWeaponInText("Cobra & Crane Deciata")).toBe("Cobra & Crane");
    expect(findWeaponInText("MK1-Braton Croni-visican")).toBe("MK1-Braton");
    expect(findWeaponInText("Kuva Bramma Toxi-critacan")).toBe("Kuva Bramma");
    expect(findWeaponInText("Verglas Visi-acricron")).toBe("Verglas");
  });
});

// Real roll-right OCR outputs from 2026-07-07 main.log: the stat crop clips the
// card's right edge, truncating stat names mid-word.
describe("parseRivenStats trait-locked stats", () => {
  // PaddleOCR drops the leading padlock and reads the trailing one as a letter.
  it("reads a locked stat that wraps onto a second line", () => {
    expect(
      parseRivenStats("Soma Argicron\nx1.5 Damage to Grineer\n+167.2% Critical\nChancee"),
    ).toMatchObject([
      { name: "Damage to Grineer", positive: true, value: 1.5, multiplier: true },
      { name: "Critical Chance", positive: true, value: 167.2 },
    ]);
    expect(
      parseRivenStats("Soma Critacak\n+133.7%×Puncture\n+167.2% Critical\nChancee"),
    ).toMatchObject([
      { name: "Puncture", positive: true, value: 133.7 },
      { name: "Critical Chance", positive: true, value: 167.2 },
    ]);
  });
});

describe("parseRivenStats truncated roll crops", () => {
  it("completes right-truncated names on the new-roll card (Boar Critadra)", () => {
    const stats = parseRivenStats(
      "Boar Critadra\n+150.6% Fire Rate (x)\nBows).\n+152.3% Critical Cha\nA -34.6% Reload Spe\nMB 10",
    );
    expect(stats).toHaveLength(3);
    expect(stats[0]).toMatchObject({ name: "Fire Rate", positive: true, value: 150.6 });
    expect(stats[1]).toMatchObject({ name: "Critical Chance", positive: true, value: 152.3 });
    expect(stats[2]).toMatchObject({ name: "Reload Speed", positive: false, value: 34.6 });
  });

  it("completes truncated names and leading icon junk on the current card", () => {
    const stats = parseRivenStats(
      "Boar Vexi-satiao\nx1.57 Damage to Infe\n+164.5% Multishc\n+129.2% 4 Electric\nAo-102.5% Status Dura\nMB 105",
    );
    expect(stats).toHaveLength(4);
    expect(stats[0]).toMatchObject({ name: "Damage to Infested", value: 1.57, multiplier: true });
    expect(stats[1]).toMatchObject({ name: "Multishot", positive: true, value: 164.5 });
    expect(stats[2]).toMatchObject({ name: "Electricity", positive: true, value: 129.2 });
    expect(stats[3]).toMatchObject({ name: "Status Duration", positive: false, value: 102.5 });
  });

  it("recovers the middle stat when the name column is clipped (Crita-arma)", () => {
    const stats = parseRivenStats(
      "Boar Crita-arma\n+52.3% Magazin\nCapacity\n+91.9%  Electrici\n+103.1% Critical Cha",
    );
    expect(stats.map((s) => s.name)).toEqual(["Magazine", "Electricity", "Critical Chance"]);
    expect(stats[2]).toMatchObject({ positive: true, value: 103.1 });
  });

  it("fuzzy-matches the merged magazine capacity line to the full stat name", () => {
    const stats = parseRivenStats("+52.3% Magazin Capacity");
    expect(stats[0]).toMatchObject({ name: "Magazine Capacity", positive: true, value: 52.3 });
  });

  it("does not upgrade a complete stat name followed by line junk", () => {
    const stats = parseRivenStats("+55.1% Critical Chance +120.4% Melee Damage");
    expect(stats.map((s) => s.name)).toEqual(["Critical Chance", "Melee Damage"]);
  });

  it("detects the weapon from the roll card title text", () => {
    expect(findWeaponInText("Boar Critadra\n+150.6% Fire Rate (x)\nBows).")).toBe("Boar");
  });
});

// The streamed diorama resource path is a localization-independent weapon ID.
describe("dioramaWeaponLoad", () => {
  it("captures the weapon path from all three resource-load line forms", () => {
    const lines = [
      "48.043 Sys [Info]: ResourceLoader 0x00000245D4699890 (/Lotus/Weapons/Grineer/KuvaLich/LongGuns/Sobek/KuvaSobek) Found 1,002 items to load (0ms) [Heap: 1,023,994,576/1,025,310,720 Footprint: 4,005,261,312 Handles: 1,362]",
      "48.080 Sys [Info]: Resloader 0x00000245D4699890 (/Lotus/Weapons/Grineer/KuvaLich/LongGuns/Sobek/KuvaSobek) starting",
      "48.096 Sys [Info]: Resource load completed 0x00000245D4699890 (/Lotus/Weapons/Grineer/KuvaLich/LongGuns/Sobek/KuvaSobek) in one pass and 0.1s (I/O ~= 8.3%, inherited 951 of 1,002)",
    ];
    for (const line of lines) {
      const m = line.match(RIVEN_PATTERNS.dioramaWeaponLoad);
      expect(m?.[1]).toBe("/Lotus/Weapons/Grineer/KuvaLich/LongGuns/Sobek/KuvaSobek");
    }
  });

  it("ignores non-weapon resource loads", () => {
    const line =
      "48.041 Sys [Info]: ResourceLoader 0x00000245D46997F0 (/Lotus/Interface/DioramaViewer.swf) Found 3 items to load (0ms)";
    expect(line.match(RIVEN_PATTERNS.dioramaWeaponLoad)).toBeNull();
  });
});

describe("getWeaponNameByUniqueName", () => {
  it("resolves the diorama weapon path to the owned variant", () => {
    expect(
      getWeaponNameByUniqueName("/Lotus/Weapons/Grineer/KuvaLich/LongGuns/Sobek/KuvaSobek"),
    ).toBe("Kuva Sobek");
    expect(getWeaponNameByUniqueName("/Lotus/Weapons/Tenno/Shotgun/PrimeBoar")).toBe("Boar Prime");
  });

  it("returns null for unknown paths", () => {
    expect(getWeaponNameByUniqueName("/Lotus/Weapons/Tenno/DoesNotExist")).toBeNull();
  });
});

describe("riven session idle timeout", () => {
  afterEach(() => {
    resetRivenState();
    vi.useRealTimers();
  });

  it("dispatches session close when the idle timer fires (stuck-overlay backstop)", () => {
    vi.useFakeTimers();
    resetRivenState();
    let closes = 0;
    setRivenCallbacks({ onRivenSessionClose: () => closes++ });

    const openLine =
      "Sys [Info]: Created /Lotus/Interface/OmegaRerollSelection.swf @ 0x12345678 of class OmegaRerollSelectionScreen";
    processRivenPatterns(openLine, "dbwin", true);
    expect(closes).toBe(0);

    vi.advanceTimersByTime(120_000);
    expect(closes).toBe(0);

    vi.advanceTimersByTime(480_000);
    expect(closes).toBe(1);
  });
});

describe("manual riven session resume", () => {
  const closeLine = "Sys [Info]: NpcManager::ClearAgents() ReadyToCreateAgents = false";
  const openLine =
    "Sys [Info]: Created /Lotus/Interface/OmegaRerollSelection.swf @ 0x12345678 of class OmegaRerollSelectionScreen";
  const cycleLine =
    "Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=Are you sure you want to cycle Kuva Bramma for 3,500?, leftItem=OK";
  const localisedDialogLine =
    "Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=Voulez-vous vraiment recycler Kuva Bramma pour 3 500 ?, leftItem=OK";
  const sendResultOk = "Script [Info]: Dialog.lua: Dialog::SendResult(4)";

  afterEach(() => {
    resetRivenState();
    vi.useRealTimers();
  });

  it("makes close markers count again for a screen whose open marker is spent", () => {
    resetRivenState();
    const closes = vi.fn();
    setRivenCallbacks({ onRivenSessionClose: closes });

    processRivenPatterns(closeLine, "dbwin", true);
    expect(closes).not.toHaveBeenCalled();

    resumeRivenSession();
    processRivenPatterns(closeLine, "dbwin", true);
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending confirm box of a live session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    resetRivenState();
    const rollConfirmed = vi.fn();
    const choiceConfirmed = vi.fn();
    setRivenCallbacks({
      onRivenRollConfirmed: rollConfirmed,
      onRivenChoiceConfirmed: choiceConfirmed,
    });

    processRivenPatterns(openLine, "dbwin", true);
    processRivenPatterns(cycleLine, "dbwin", true);
    resumeRivenSession();
    processRivenPatterns(sendResultOk, "dbwin", true);

    expect(rollConfirmed).toHaveBeenCalledTimes(1);
    expect(choiceConfirmed).not.toHaveBeenCalled();
  });

  it("keeps the cycle/choice alternation of a live session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    resetRivenState();
    const rollPending = vi.fn();
    const rollConfirmed = vi.fn();
    const choiceConfirmed = vi.fn();
    setRivenCallbacks({
      onRivenRollPending: rollPending,
      onRivenRollConfirmed: rollConfirmed,
      onRivenChoiceConfirmed: choiceConfirmed,
    });

    processRivenPatterns(openLine, "dbwin", true);
    processRivenPatterns(localisedDialogLine, "dbwin", true);
    processRivenPatterns(sendResultOk, "dbwin", true);
    expect(rollPending).toHaveBeenCalledTimes(1);
    expect(rollConfirmed).toHaveBeenCalledTimes(1);

    resumeRivenSession();
    vi.advanceTimersByTime(1_000);
    processRivenPatterns(localisedDialogLine, "dbwin", true);
    vi.advanceTimersByTime(1_000);
    processRivenPatterns(sendResultOk, "dbwin", true);

    expect(choiceConfirmed).toHaveBeenCalledTimes(1);
    expect(rollPending).toHaveBeenCalledTimes(1);
  });
});

describe("riven session reopen and close timing", () => {
  const openLine =
    "Sys [Info]: Created /Lotus/Interface/OmegaRerollSelection.swf @ 0x12345678 of class OmegaRerollSelectionScreen";
  const dioramaLine = "Script [Info]: OmegaRerollSelection.lua: Diorama setup complete";
  const closeLine = "Sys [Info]: NpcManager::ClearAgents() ReadyToCreateAgents = false";
  const process = (line: string) => processRivenPatterns(line, "dbwin", true);

  afterEach(() => {
    resetRivenState();
    vi.useRealTimers();
  });

  function freshCallbacks() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
    resetRivenState();
    const opens = vi.fn();
    const closes = vi.fn();
    setRivenCallbacks({ onRivenSessionOpen: opens, onRivenSessionClose: closes });
    return { opens, closes };
  }

  it("absorbs the open-marker burst without reopening", () => {
    const { opens } = freshCallbacks();
    process(openLine);
    process(openLine);
    process(openLine);
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh session seconds after the previous close", () => {
    const { opens, closes } = freshCallbacks();
    process(openLine);
    process(dioramaLine);
    vi.advanceTimersByTime(9_000);
    process(closeLine);
    expect(closes).toHaveBeenCalledTimes(1);

    // A reroll ~3s after the close must still open; no post-close cooldown may eat it.
    vi.advanceTimersByTime(3_000);
    process(openLine);
    expect(opens).toHaveBeenCalledTimes(2);
  });

  it("closes a session the user leaves after barely a second", () => {
    const { closes } = freshCallbacks();
    process(openLine);
    vi.advanceTimersByTime(650);
    process(dioramaLine);
    vi.advanceTimersByTime(650);
    process(closeLine);
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("reopens right after a fast close without a lingering cooldown", () => {
    const { opens } = freshCallbacks();
    process(openLine);
    vi.advanceTimersByTime(650);
    process(dioramaLine);
    vi.advanceTimersByTime(650);
    process(closeLine);
    // 650 + 650 + 200 lands 1.5s after the previous open, inside any open cooldown.
    vi.advanceTimersByTime(200);
    process(openLine);
    expect(opens).toHaveBeenCalledTimes(2);
  });

  it("ignores teardown stragglers trailing the previous close into a reopen", () => {
    const { opens, closes } = freshCallbacks();
    process(openLine);
    process(dioramaLine);
    vi.advanceTimersByTime(9_000);
    process(closeLine);

    vi.advanceTimersByTime(1_000);
    process(openLine);
    vi.advanceTimersByTime(650);
    process(dioramaLine);
    // The previous close's straggler lands after the fresh diorama is ready.
    vi.advanceTimersByTime(150);
    process(closeLine);
    expect(closes).toHaveBeenCalledTimes(1);

    // The user's real exit sits beyond the trailing window and still closes.
    vi.advanceTimersByTime(2_100);
    process(closeLine);
    expect(closes).toHaveBeenCalledTimes(2);
    expect(opens).toHaveBeenCalledTimes(2);
  });
});

describe("looksLikeStaleCardRead", () => {
  // The roll-reveal animation scrambles this text, so a too-early scan reads the
  // current card back with 2+ values intact.
  const currentCard: RivenStat[] = [
    { name: "Damage to Infested", positive: true, value: 1.57, multiplier: true },
    { name: "Multishot", positive: true, value: 155.2 },
    { name: "Critical Chance", positive: true, value: 121.8 },
    { name: "Impact", positive: false, value: 116.5 },
  ];

  it("flags a mid-animation read of the current card (field log repro)", () => {
    // Scan caught the scramble: two stats still exact, Impact garbled to 12116.5.
    const scanned: RivenStat[] = [
      { name: "Damage to Infested", positive: true, value: 1.57, multiplier: true },
      { name: "Critical Chance", positive: true, value: 121.8 },
      { name: "Impact", positive: true, value: 12116.5 },
    ];
    expect(looksLikeStaleCardRead(scanned, [currentCard])).toBe(true);
  });

  it("accepts a genuine reroll even when stat names repeat", () => {
    const scanned: RivenStat[] = [
      { name: "Multishot", positive: true, value: 108.3 },
      { name: "Status Chance", positive: true, value: 97.9 },
      { name: "Fire Rate", positive: true, value: 88.1 },
    ];
    expect(looksLikeStaleCardRead(scanned, [currentCard])).toBe(false);
  });

  it("accepts a reroll sharing one exact stat value by chance", () => {
    const scanned: RivenStat[] = [
      { name: "Critical Chance", positive: true, value: 121.8 },
      { name: "Heat", positive: true, value: 143.5 },
      { name: "Toxin", positive: true, value: 151.5 },
    ];
    expect(looksLikeStaleCardRead(scanned, [currentCard])).toBe(false);
  });

  it("checks every known card, not just the first", () => {
    const previousRoll: RivenStat[] = [
      { name: "Heat", positive: true, value: 138 },
      { name: "Toxin", positive: true, value: 151.5 },
      { name: "Status Duration", positive: false, value: 65.3 },
    ];
    const rereadOfPreviousRoll: RivenStat[] = [
      { name: "Heat", positive: true, value: 138 },
      { name: "Toxin", positive: true, value: 151.5 },
    ];
    expect(looksLikeStaleCardRead(rereadOfPreviousRoll, [currentCard, previousRoll])).toBe(true);
  });

  it("never flags sparse or unknown-card scans", () => {
    const single: RivenStat[] = [{ name: "Multishot", positive: true, value: 155.2 }];
    expect(looksLikeStaleCardRead(single, [currentCard])).toBe(false);
    expect(looksLikeStaleCardRead(currentCard, [[]])).toBe(false);
    expect(looksLikeStaleCardRead([], [currentCard])).toBe(false);
  });

  it("requires matching sign, so a flipped curse does not count", () => {
    // Only one true exact match (Multishot); Impact differs in sign.
    const scanned: RivenStat[] = [
      { name: "Multishot", positive: true, value: 155.2 },
      { name: "Impact", positive: true, value: 116.5 },
    ];
    expect(looksLikeStaleCardRead(scanned, [currentCard])).toBe(false);
  });
});

describe("rollRescanReason", () => {
  const currentCard: RivenStat[] = [
    { name: "Multishot", positive: true, value: 155.2 },
    { name: "Critical Chance", positive: true, value: 121.8 },
  ];

  it("rescans an empty read: the OCR rejects a card the reveal effect covers", () => {
    expect(rollRescanReason([], [currentCard])).toBe("read nothing");
  });

  it("rescans a read of a pre-roll card", () => {
    expect(rollRescanReason(currentCard, [currentCard])).toBe("matches a pre-roll card");
  });

  it("keeps a settled read", () => {
    const rolled: RivenStat[] = [
      { name: "Heat", positive: true, value: 138 },
      { name: "Toxin", positive: true, value: 151.5 },
    ];
    expect(rollRescanReason(rolled, [currentCard])).toBeNull();
  });
});
