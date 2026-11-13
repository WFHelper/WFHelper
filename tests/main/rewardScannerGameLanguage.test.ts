import { describe, expect, it, vi } from "vitest";

import { rankRewardCandidatesDetailed, type SortedItem } from "../../services/rewardScannerMatch";

const pipeline = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../../services/rewardScannerPipeline", () => ({
  resetFrameDedup: () => {},
  runRewardScanPipeline: pipeline.run,
}));
vi.mock("../../services/rewardScannerOcr", () => ({
  createRewardOcrRunner: () => ({}),
  createEraOcr: () => ({}),
}));
vi.mock("../../services/rewardOcrOnnx", () => ({
  recognizeRewardStripOnnx: () => null,
  rewardOcrOnnxAvailable: () => false,
}));
vi.mock("../../services/screenCapture", () => ({ captureSourceMeta: () => null }));

const FRENCH_REWARDS = [
  { name: "Volt Prime Chassis Blueprint", displayName: "Volt Prime - Châssis" },
  { name: "Volt Prime Systems Blueprint", displayName: "Volt Prime - Systèmes" },
  { name: "Forma Blueprint", displayName: "Forma (Schéma)" },
  { name: "2X Forma Blueprint", displayName: "Forma (Schéma)" },
];

describe("reward scan in a non-English game", () => {
  it("matches the localized card text and hands back the English name", async () => {
    const rewardScanner = await import("../../services/rewardScanner");
    rewardScanner.setRelicItems(FRENCH_REWARDS);
    let pool: SortedItem[] = [];
    pipeline.run.mockImplementationOnce(async ({ sortedItems }) => {
      pool = sortedItems;
      return null;
    });
    await rewardScanner.scanRewardsDetailed();

    // The English OCR model reads "Châssis" without its accent.
    const chassis = rankRewardCandidatesDetailed("Volt Prime - Chassis", pool, 1)[0];
    expect(chassis.mode).toBe("exact");
    const doubleForma = rankRewardCandidatesDetailed("2 X Forma (Schema)", pool, 1)[0];
    expect(doubleForma.item?.englishName).toBe("2X Forma Blueprint");

    pipeline.run.mockResolvedValueOnce({ items: [chassis.item], meta: {} });
    const result = await rewardScanner.scanRewardsDetailed();
    expect(result?.items[0]).toMatchObject({ name: "Volt Prime Chassis Blueprint" });
    expect(result?.items[0]).not.toHaveProperty("englishName");
  });
});
