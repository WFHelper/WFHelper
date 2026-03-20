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

  it("corrects common OCR misreads via expanded token aliases", () => {
    // "prlme" → "prime", "bluedrint" → "blueprint"
    const r1 = matchSingleRewardTextDetailed("Rhino Prlme BlueDrint", ITEMS);
    expect(r1.item?.name).toBe("Rhino Prime Blueprint");

    // "neurootics" → "neuroptics"
    const r2 = matchSingleRewardTextDetailed("Zephyr Prime Neurootics Blueprint", ITEMS);
    expect(r2.item?.name).toBe("Zephyr Prime Neuroptics Blueprint");

    // "svstems" → "systems"
    const r3 = matchSingleRewardTextDetailed("Nautilus Prime Svstems", ITEMS);
    expect(r3.item?.name).toBe("Nautilus Prime Systems");

    // "trinlty" → "trinity"
    const r4 = matchSingleRewardTextDetailed("Trinlty Prime Blueprint", ITEMS);
    expect(r4.item?.name).toBe("Trinity Prime Blueprint");

    // "chassls" → "chassis"
    const r5 = matchSingleRewardTextDetailed("Wukong Prime Chassls Blueprint", ITEMS);
    expect(r5.item?.name).toBe("Wukong Prime Chassis Blueprint");
  });
});
