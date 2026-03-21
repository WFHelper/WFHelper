import { describe, expect, it } from "vitest";
import { RIVEN_PATTERNS } from "../../services/eeLogMonitor";
import { __test__ as rivenScanTest, parseRivenStats } from "../../ipc/overlay/rivenScan";
import { findWeaponInText } from "../../services/rivenData";

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
    // WinRT OCR on bright-150+dilate sometimes places the riven-name suffix (e.g.
    // "Gelimantiton") BETWEEN the element value line and the element name line.
    // The FIFO queue in collapseOrphanValueLines must skip over that noise and pair
    // "+95.5%" with "Cold", not with "Gelimantiton".
    const text = [
      "+95,50/0",        // Cold value (+95.5%) — 0/0 is WinRT misread of %
      "Gelimantiton",    // riven-name suffix injected as a stats-area line by WinRT
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
    // bright+dilate OCR produces two orphan values then a stat+value line:
    //   "+180.7%" "+133.9%" "-1.1 Range"
    // The -1.1 belongs to Range and must NOT be overwritten by the orphan +180.7.
    const text = ["+180.7%", "+133.9%", "-1.1 Range"].join("\n");
    const result = parseRivenStats(text);
    const range = result.find((s) => s.name === "Range");
    expect(range).toBeDefined();
    expect(range!.value).toBe(1.1);
    expect(range!.positive).toBe(false);
    // orphan values have no stat name — expect only Range
    expect(result).toHaveLength(1);
  });

  it("does not carry-forward when icon-artifact dash present before element stat (Magnatox scenario)", () => {
    // WinRT reads element icons as "-ÔÇ×e" between Impact and Toxin.
    // The prefix " -ÔÇ×e " contains "-" followed by garbage chars, so carry-forward
    // must NOT fire — Impact=180.7 must not bleed into Toxin (separate card rows).
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
    // WinRT reads "+126.2% Status Duration + Electricity" as a single line.
    // Status Duration is NOT a damage-type stat, so the "+" before Electricity
    // is the sign indicator for a separate stat — not a combined element.
    // Carry-forward must NOT fire; Electricity should have null value.
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
    // Combined element roll: "+112% Electricity Impact" — both are damage types.
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

  it("fixes spaced decimal point in OCR values (+151 .4% → +151.4%)", () => {
    const text = "+2.5 Range\n+70.6% Attack Speed\n+151 .4% Impact\n-8.6 Combo Duration";
    const result = parseRivenStats(text);
    const impact = result.find((s) => s.name === "Impact");
    expect(impact).toBeDefined();
    expect(impact!.value).toBe(151.4);
    expect(impact!.positive).toBe(true);
  });

  it("fixes OCR misread xO→x0 in multiplier values (xO,58 Damage to Grineer)", () => {
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

  it("fixes OCR misread xl→x1 in multiplier values (xl,56 Damage to Corpus)", () => {
    // WinRT OCR reads digit 1 as lowercase l: "xl,56" instead of "x1,56"
    const text =
      "+136,2% Impact +9,7s Combo Duration xl,56 Damage to Corpus -52,5% Attack Speed";
    const result = parseRivenStats(text);
    const dmg = result.find((s) => s.name === "Damage to Corpus");
    expect(dmg).toBeDefined();
    expect(dmg!.value).toBe(1.56);
    expect(dmg!.multiplier).toBe(true);
    expect(dmg!.positive).toBe(true);
  });

  it("fixes spaced multiplier misread 'x I , 44 Damage to Grineer' → x1.44", () => {
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
    // WinRT OCR reads "+112,3% 4 Electricity *Impact" — after icon stripping
    // "Impact" appears on the same sub-line as "Electricity" with no preceding value.
    const result = parseRivenStats("+112,3% 4 Electricity *Impact +117,2% Critical Damage -53% Attack Speed");
    const elec = result.find((s) => s.name === "Electricity");
    const imp = result.find((s) => s.name === "Impact");
    expect(elec).toBeDefined();
    expect(elec!.value).toBe(112.3);
    expect(imp).toBeDefined();
    expect(imp!.value).toBe(112.3);
    expect(imp!.positive).toBe(true);
  });

  it("carries value to Impact when appearing after Impact on same line", () => {
    const result = parseRivenStats("+134,6% *Impact v Slash +119,2% Status Chance -106,2% Chance to Gain Combo Count");
    const imp = result.find((s) => s.name === "Impact");
    const slash = result.find((s) => s.name === "Slash");
    expect(imp).toBeDefined();
    expect(imp!.value).toBe(134.6);
    expect(slash).toBeDefined();
    expect(slash!.value).toBe(134.6);
  });

  it("rejoins split x-multiplier decimal: WinRT splits 'x 1,3 Damage' into 'x 1' + ',3 Damage to Corpus'", () => {
    // WinRT OCR splits the word group across two lines when the icon between
    // "x value" and "Stat Name" causes a layout break.
    // After xl-fix "x 1" → "x1" and comma→dot ",3" → ".3", the preprocessor
    // must join "x1\n.3 Damage to Corpus" into "x1.3 Damage to Corpus".
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
    // WinRT OCR merges "x 1,36 Damage to Grineer" and "*Heat" onto one line when
    // the Heat value "+62,2%" is missed entirely. The carry-forward must NOT
    // assign Grineer's multiplier value (1.36) to Heat.
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

  it("normalises spaced decimal comma in percent value: '+62, 2% Heat' → 62.2", () => {
    // WinRT OCR sometimes outputs "+62.2%" as "+62, 2%" when the decimal separator
    // (comma) is followed by a space.  The preprocessing fix must recover the full
    // value before parsing so Heat gets 62.2, not 2 or carry-forward.
    const text =
      "x1.3 Damage to Corpus\nx1.36 Damage to Grineer\n+62, 2% Heat\n-68.4% Impact";
    const result = parseRivenStats(text);
    const heat = result.find((s) => s.name === "Heat");
    expect(heat).toBeDefined();
    expect(heat!.value).toBeCloseTo(62.2, 5);
    expect(heat!.positive).toBe(true);
  });

  it("orphan '+62,' (trailing comma) pairs with following stat name", () => {
    // WinRT OCR splits "+62.2%" across two structural lines: "+62," and "2% Heat".
    // The orphan-value detection must recognise "+62," (with trailing comma) as a
    // value fragment, so Heat doesn't fall through to carry-forward.
    const text = "+62,\nHeat";
    const result = parseRivenStats(text);
    const heat = result.find((s) => s.name === "Heat");
    expect(heat).toBeDefined();
    expect(heat!.positive).toBe(true);
    // Value is 62 (integer part of +62.2) — the orphan pairs the fragment with Heat
    expect(heat!.value).toBe(62);
  });

  it("deduplication prefers non-integer over integer value for same stat (xl vs x1.3)", () => {
    // The duplicate stat panel typically OCRs "xl" → x1 (value=1) while the main
    // panel shows "x 1,3" → x1.3 (value=1.3).  Bounding-box sort may put the
    // duplicate first; the parser must keep the more precise value.
    const text = "xl Damage to Corpus\nx 1,3 Damage to Corpus";
    const result = parseRivenStats(text);
    // Only one "Damage to Corpus" entry
    const matches = result.filter((s) => s.name === "Damage to Corpus");
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBeCloseTo(1.3, 5);
    expect(matches[0].multiplier).toBe(true);
  });

  it("deduplication does NOT replace when integer parts differ (value=2 vs value=62.2)", () => {
    // Ensure the precision-replacement only fires when the integer-part matches
    // (floor(new)==existing).  A genuine duplicate like "+2% Heat" followed by
    // "+62.2% Heat" must NOT replace the first entry because floor(62.2)=62 ≠ 2.
    const text = "+2% Heat\n+62.2% Heat";
    const result = parseRivenStats(text);
    const matches = result.filter((s) => s.name === "Heat");
    expect(matches).toHaveLength(1);
    // First occurrence (value=2) is kept; second does not satisfy floor(62.2)=2
    expect(matches[0].value).toBe(2);
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
});

describe("scoreStatsCandidate", () => {
  it("prefers plausible mapped stat sets over absurd OCR output", () => {
    const plausible = rivenScanTest.scoreStatsCandidate(
      [
        { name: "Critical Chance", positive: true, value: 185.5 },
        { name: "Melee Damage", positive: true, value: 186.7 },
        { name: "Combo Duration", positive: true, value: 8.5 },
        { name: "Damage to Infested", positive: false, value: 0.62, multiplier: true },
      ],
      "Nikana Crita-acrit\n+186.7% Melee Damage",
      "Nikana",
    );

    const implausible = rivenScanTest.scoreStatsCandidate(
      [
        { name: "Critical Chance", positive: true, value: 1855 },
        { name: "Melee Damage", positive: true, value: 1867 },
        { name: "Unknown Noise", positive: true, value: 999 },
        { name: "Critical Chance", positive: true, value: 1855 },
      ],
      "Nikana Crita-acrit\n+1867% Melee Damage",
      "Nikana",
    );

    expect(plausible).toBeGreaterThan(implausible);
  });
});
