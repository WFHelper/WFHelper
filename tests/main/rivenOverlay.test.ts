import { describe, expect, it } from "vitest";
import { RIVEN_PATTERNS } from "../../services/eeLogMonitor";
import { parseRivenStats } from "../../ipc/overlay/rivenScan";

// ── EE.log riven pattern tests ────────────────────────────────────────────────

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
      const line =
        "Dialog::CreateOkCancel(description=Cycle Riven into current selection?, ...)";
      expect(RIVEN_PATTERNS.cycleConfirmEn.test(line)).toBe(false);
    });
  });

  describe("choiceConfirmEn", () => {
    it("matches the keep/reroll choice dialog (English)", () => {
      const line =
        "Dialog::CreateOkCancel(description=Cycle Riven into current selection?, ...)";
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
      expect(
        RIVEN_PATTERNS.genericDialog.test("Dialog.lua: Dialog::SendResult(4)"),
      ).toBe(false);
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

  describe("chatRivenView", () => {
    it("matches HudVis 1 (chat riven opened)", () => {
      const line = "ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1";
      expect(RIVEN_PATTERNS.chatRivenView.test(line)).toBe(true);
    });

    it("does not match HudVis 0 (chat riven closed)", () => {
      expect(
        RIVEN_PATTERNS.chatRivenView.test("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 0"),
      ).toBe(false);
    });
  });

  describe("chatRivenClose", () => {
    it("matches HudVis 0 (chat riven closed)", () => {
      const line = "ThemedDetailedPurchaseDialog.lua: DBG: HudVis 0";
      expect(RIVEN_PATTERNS.chatRivenClose.test(line)).toBe(true);
    });

    it("does not match HudVis 1 (chat riven opened)", () => {
      expect(
        RIVEN_PATTERNS.chatRivenClose.test("ThemedDetailedPurchaseDialog.lua: DBG: HudVis 1"),
      ).toBe(false);
    });
  });
});

// ── parseRivenStats tests ─────────────────────────────────────────────────────

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
    expect(result[0].positive).toBe(false);
    expect(result[0].value).toBe(94.5);
  });

  it("recognises a negative stat with hyphen-minus and value", () => {
    const result = parseRivenStats("-27.3% Zoom");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Zoom");
    expect(result[0].positive).toBe(false);
    expect(result[0].value).toBe(27.3);
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
    // No sign/value → positive=true, value=null
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
    // Value for Critical Chance: prefix "+1 90,9%" → collapse spaces → "+190,9%" → 190.9
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
    const text = [
      "+50.2% Attack Speed",
      "+120% Range",
      "-30% Combo Duration",
    ].join("\n");
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

  it("sanitises unreasonably large values (dropped decimal: 1552 → 155.2)", () => {
    const result = parseRivenStats("+1552% Critical Damage");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(155.2);
    expect(result[0].positive).toBe(true);
  });

  it("sanitises 739 → 73.9 (dropped comma)", () => {
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

  it("recovers decimal in 165 4% → 165.4%", () => {
    const result = parseRivenStats("-165 4% Recoil");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(165.4);
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

  it("strips (x2 for Heavy Attacks) qualifier — not a separate stat", () => {
    const text = "+185,5% Critical Chance\n(x2 for Heavy Attacks)\n+8,5s Combo Duration";
    const result = parseRivenStats(text);
    // Should have Critical Chance + Combo Duration, NOT Heavy Attack
    const names = result.map((s) => s.name);
    expect(names).toContain("Critical Chance");
    expect(names).toContain("Combo Duration");
    expect(names).not.toContain("Heavy Attack");
  });

  it("strips seconds suffix from Combo Duration (8,5s → 8.5)", () => {
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
    const text = "+186,7% Melee Damage\n+185,5% Critical Chance\n(x2 for Heavy Attacks)\n+8,5s Combo Duration\nx0,62 Damage to Infested";
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
    const text = "+128,1% Critical Chance\nfor Slide Attack\n+157% Melee Damage\n+98,8% Heat\n-147,6% Critical Chance\n(x2 for Heavy Attacks)";
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
});
