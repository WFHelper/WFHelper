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
});
