import { describe, expect, it, vi } from "vitest";

import { scanRewardSlotsFallback } from "../../services/rewardScannerSlotScan";

const h = vi.hoisted(() => ({
  layouts: [] as unknown[],
  matches: {} as Record<string, unknown[]>,
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../services/rewardScanDebug", () => ({ dumpRewardScanDebug: vi.fn() }));
vi.mock("../../services/rewardScannerSupport", () => ({ hasConfidentSlotLayout: () => true }));
vi.mock("../../services/rewardOcrOnnx", () => ({
  rewardOcrOnnxAvailable: () => false,
  recognizeRewardStripOnnx: vi.fn(),
}));
vi.mock("../../services/rewardScannerMatch", () => ({
  MAX_REWARD_SLOTS: 4,
  rankRewardCandidatesDetailed: (text: string) => h.matches[text] || [],
}));
vi.mock("../../services/rewardScannerImage", () => ({
  detectRewardSlotLayoutCandidates: () => h.layouts,
  binarizeRewardRegion: async (png: Buffer) => png,
  cropRect: (_image: unknown, rect: { x: number }) => ({
    toPNG: () => Buffer.from(`crop:${rect.x}`),
  }),
}));

function slot(x: number) {
  return { titleRect: { x, y: 0, width: 90, height: 20 } };
}

function match(name: string, score = 200) {
  return [{ item: { name }, confidence: 0.99, score, mode: "exact" }];
}

async function scan(ocrByCrop: Record<string, string>) {
  return scanRewardSlotsFallback({ image: {} as never }, 4, 60_000, Date.now(), {
    sortedItems: [],
    ocrTimeoutMs: 1000,
    runOCRStructuredBuffer: async (buffer: Buffer) => ({
      text: ocrByCrop[buffer.toString()] || "",
    }),
    reader: "windows",
  });
}

describe("scanRewardSlotsFallback layout merge", () => {
  it("fills the winner's empty slots from losing layout hits at the same x", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 3, confidence: 0.7, slots: [slot(10), slot(150), slot(302)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "item delta": match("Item Delta"),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:302": "item delta",
    });

    expect(result?.strategy).toBe("slot-merged");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Item Alpha",
      "Item Beta",
      "Item Gamma",
      "Item Delta",
    ]);
    expect(result?.items.map((item) => item.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(result?.emptySlots).toBe(0);
    expect(result?.matchedSlots).toBe(4);
  });

  it("never overrides a slot the winner already filled", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 3, confidence: 0.7, slots: [slot(10), slot(150), slot(302)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "wrong item": match("Wrong Item", 500),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:10": "wrong item",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Item Alpha",
      "Item Beta",
      "Item Gamma",
    ]);
    expect(result?.emptySlots).toBe(1);
  });

  it("ignores donors that barely overlap any winner slot", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.7, slots: [slot(150), slot(355)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "item delta": match("Item Delta"),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:355": "item delta",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items).toHaveLength(3);
  });
});
