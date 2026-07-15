import { describe, expect, it } from "vitest";
import {
  matchSingleRewardTextDetailed,
  rankRewardCandidatesDetailed,
} from "../../services/rewardScannerMatch";

const ITEMS = [
  { name: "Braton Prime Stock" },
  { name: "Trumna Prime Blueprint" },
  { name: "Forma Blueprint" },
  { name: "Caliban Prime Neuroptics Blueprint" },
  { name: "Nautilus Prime Systems" },
  { name: "Epitaph Prime Receiver" },
  { name: "Zephyr Prime Neuroptics Blueprint" },
  { name: "Wukong Prime Chassis Blueprint" },
  { name: "Rhino Prime Blueprint" },
  { name: "Trinity Prime Blueprint" },
  { name: "Limbo Prime Blueprint" },
  { name: "Saryn Prime Blueprint" },
];

describe("matchSingleRewardTextDetailed", () => {
  it("matches exact or near-exact reward names", () => {
    const result = matchSingleRewardTextDetailed("Forma BlueDrint", ITEMS);
    expect(result.item?.name).toBe("Forma Blueprint");
  });

  it("handles fuzzy OCR output for receiver", () => {
    const result = matchSingleRewardTextDetailed("E itaDh Prime Receiver", ITEMS);
    expect(result.item?.name).toBe("Epitaph Prime Receiver");
  });

  it("keeps top candidates for split OCR strings", () => {
    const ranked = rankRewardCandidatesDetailed("Caliban Blueprint Naut", ITEMS, 3);
    expect(
      ranked.some((candidate) => candidate.item?.name === "Caliban Prime Neuroptics Blueprint"),
    ).toBe(true);
  });

  it("does not extract short reward names from inside longer titles", () => {
    const ranked = rankRewardCandidatesDetailed(
      "Paris Prime Upper Limb",
      [{ name: "Paris Prime Upper Limb" }, { name: "Ris" }],
      3,
    );
    expect(ranked[0].item?.name).toBe("Paris Prime Upper Limb");
    expect(ranked.some((candidate) => candidate.item?.name === "Ris")).toBe(false);
  });

  it("still matches exact short Requiem mod names", () => {
    const requiemMods = ["Fass", "Jahu", "Khra", "Lohk", "Netra", "Ris", "Vome", "Xata", "Oull"];
    for (const name of requiemMods) {
      const ranked = rankRewardCandidatesDetailed(
        name.toUpperCase(),
        [{ name: "Paris Prime Upper Limb" }, ...requiemMods.map((modName) => ({ name: modName }))],
        3,
      );
      expect(ranked[0].item?.name).toBe(name);
      expect(ranked[0].mode).toBe("exact");
    }
  });

  it("lifts a first-line-only read that uniquely prefixes one item over the slot gate", () => {
    // "Yareli Prime Chassis Blueprint" wraps to two lines on the reward card;
    // OCR of the first line alone must still resolve it.
    const pool = [
      { name: "Yareli Prime Chassis Blueprint" },
      { name: "Yareli Prime Blueprint" },
      { name: "Yareli Prime Systems Blueprint" },
      { name: "Yareli Prime Neuroptics Blueprint" },
      ...ITEMS,
    ];
    const ranked = rankRewardCandidatesDetailed("Yareli Prime Chassis", pool, 4);
    expect(ranked[0].item?.name).toBe("Yareli Prime Chassis Blueprint");
    expect(ranked[0].mode).toBe("substring");
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("keeps ambiguous prefixes below the slot gate", () => {
    const pool = [
      { name: "Braton Prime Stock" },
      { name: "Braton Prime Blueprint" },
      { name: "Braton Prime Receiver" },
      { name: "Braton Prime Barrel" },
    ];
    const ranked = rankRewardCandidatesDetailed("Braton Prime", pool, 4);
    for (const candidate of ranked) {
      if (candidate.mode === "substring") {
        expect(candidate.confidence).toBeLessThan(0.92);
      }
    }
  });

  it("does not boost single-word fragments", () => {
    const ranked = rankRewardCandidatesDetailed("Yareli", [{ name: "Yareli Prime Blueprint" }], 3);
    for (const candidate of ranked) {
      expect(candidate.confidence).toBeLessThan(0.92);
    }
  });

  it("corrects common OCR misreads via expanded token aliases", () => {
    // "prlme" -> "prime", "bluedrint" -> "blueprint"
    const r1 = matchSingleRewardTextDetailed("Rhino Prlme BlueDrint", ITEMS);
    expect(r1.item?.name).toBe("Rhino Prime Blueprint");

    // "neurootics" -> "neuroptics"
    const r2 = matchSingleRewardTextDetailed("Zephyr Prime Neurootics Blueprint", ITEMS);
    expect(r2.item?.name).toBe("Zephyr Prime Neuroptics Blueprint");

    // "svstems" -> "systems"
    const r3 = matchSingleRewardTextDetailed("Nautilus Prime Svstems", ITEMS);
    expect(r3.item?.name).toBe("Nautilus Prime Systems");

    // "trinlty" -> "trinity"
    const r4 = matchSingleRewardTextDetailed("Trinlty Prime Blueprint", ITEMS);
    expect(r4.item?.name).toBe("Trinity Prime Blueprint");

    // "chassls" -> "chassis"
    const r5 = matchSingleRewardTextDetailed("Wukong Prime Chassls Blueprint", ITEMS);
    expect(r5.item?.name).toBe("Wukong Prime Chassis Blueprint");
  });
});
