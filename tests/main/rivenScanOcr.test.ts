import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ png: Buffer.alloc(0) }));
const recognizeStatAreaMock = vi.fn();
const lowConfidenceMock = vi.fn((_result: { minConfidence: number }) => false);

vi.mock("../../services/rivenOcrOnnx", () => ({
  rivenOcrOnnxAvailable: () => true,
  recognizeStatArea: (...args: unknown[]) => recognizeStatAreaMock(...args),
  hasLowConfidenceLine: (result: { minConfidence: number }) => lowConfidenceMock(result),
  LOW_CONFIDENCE_THRESHOLD: 0.8,
}));

vi.mock("../../services/rewardScanDebug", () => ({
  areOcrDebugDumpsEnabled: () => false,
}));

vi.mock("../../ipc/overlay/rivenScanImage", () => {
  const crop = () => ({
    getSize: () => ({ width: 64, height: 48 }),
    toPNG: () => holder.png,
  });
  return {
    cropRivenStatImage: () => ({ cardCrop: crop(), statCrop: crop() }),
    cropRivenStatAreaFallback: () => null,
    statCropUpscaleFactor: (height: number) => Math.min(3, Math.max(1, Math.ceil(320 / height))),
  };
});

import { isIncompleteRivenRead, recognizeRivenCardStats } from "../../ipc/overlay/rivenScanOcr";

describe("recognizeRivenCardStats", () => {
  // A test that pins its own confidence rule or queues reads with Once must not
  // decide what the next one sees. mockReset puts the vi.fn factory impl back.
  beforeEach(() => {
    recognizeStatAreaMock.mockReset();
    lowConfidenceMock.mockReset();
  });

  it("refuses a read that recovered fewer than two stats", async () => {
    const sharp = (await import("sharp")).default;
    holder.png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 10, b: 18 } },
    })
      .png()
      .toBuffer();

    // A degraded frame that only ever yields one stat line.
    recognizeStatAreaMock.mockResolvedValue({
      lines: [{ text: "-66.2% Weapon Recoil", confidence: 0.9 }],
      text: "-66.2% Weapon Recoil",
      minConfidence: 0.9,
      yoloBoxCount: 3,
    });

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.stats).toEqual([]);
    expect(result.lowConfidence).toBe(true);
  });

  it("takes a retry that ties on stat count but reads with more confidence", async () => {
    const sharp = (await import("sharp")).default;
    holder.png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 10, b: 18 } },
    })
      .png()
      .toBuffer();

    lowConfidenceMock.mockImplementation((result) => result.minConfidence < 0.8);
    const read = (minConfidence: number) => ({
      lines: [
        { text: "Skana Acritor", confidence: 0.95 },
        { text: "+104.6% Critical Damage", confidence: minConfidence },
        { text: "+2.3 Range", confidence: minConfidence },
      ],
      text: "Skana Acritor\n+104.6% Critical Damage\n+2.3 Range",
      minConfidence,
      yoloBoxCount: 4,
    });
    recognizeStatAreaMock
      .mockResolvedValueOnce(read(0.714))
      .mockResolvedValueOnce(read(0.87))
      .mockResolvedValue(read(0.87));

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.lowConfidence).toBe(false);
    expect(result.stats).toHaveLength(2);
  });
});

describe("isIncompleteRivenRead", () => {
  const stat = (name: string, positive: boolean) => ({ name, positive, value: 10 });

  it("accepts the shapes a riven can actually roll", () => {
    expect(isIncompleteRivenRead([stat("Damage", true), stat("Multishot", true)])).toBe(false);
    expect(
      isIncompleteRivenRead([
        stat("Damage", true),
        stat("Multishot", true),
        stat("Critical Chance", false),
      ]),
    ).toBe(false);
  });

  // Field log, 2560x1440 with Legacy menu scale: the retry crop spanned both roll cards.
  it("rejects five stats, which no riven has", () => {
    expect(
      isIncompleteRivenRead([
        { name: "Electricity", positive: true, value: 102 },
        { name: "Attack Speed", positive: true, value: 4.1 },
        { name: "Critical Damage", positive: true, value: 132.1 },
        { name: "Damage to Infested", positive: true, value: 3, multiplier: true },
        { name: "Damage to Corpus", positive: true, value: 1.65, multiplier: true },
      ]),
    ).toBe(true);
  });

  it("rejects a read that kept a curse but lost a buff", () => {
    expect(isIncompleteRivenRead([stat("Damage", true), stat("Zoom", false)])).toBe(true);
    expect(isIncompleteRivenRead([stat("Damage", true)])).toBe(true);
  });

  it("rejects the field repro: one buff plus a faction curse", () => {
    expect(
      isIncompleteRivenRead([
        { name: "Reload Speed", positive: true, value: 72.5 },
        { name: "Damage to Corpus", positive: false, value: 0.75, multiplier: true },
      ]),
    ).toBe(true);
  });

  it("leaves an empty read to the empty-scan path", () => {
    expect(isIncompleteRivenRead([])).toBe(false);
  });

  it("rejects two buffs when a third stat-shaped line went unread", () => {
    const twoBuffs = [
      { name: "Damage to Corpus", positive: true, value: 1.36, multiplier: true },
      { name: "Critical Chance for Slide Attack", positive: true, value: 108 },
    ];
    expect(isIncompleteRivenRead(twoBuffs, true)).toBe(true);
    expect(isIncompleteRivenRead(twoBuffs, false)).toBe(false);
  });

  // Field log: "-32.4% Status Char" went unread under three parsed stats.
  it("rejects three stats when a fourth stat line went unread", () => {
    const three = [stat("Damage", true), stat("Multishot", true), stat("Zoom", false)];
    expect(isIncompleteRivenRead(three, true)).toBe(true);
    expect(isIncompleteRivenRead([...three, stat("Toxin", true)], true)).toBe(false);
  });

  // Mid-reveal roll captures lose the title and the top stat line together.
  it("rejects a read below four stats with no title above it", () => {
    const three = [stat("Damage", true), stat("Multishot", true), stat("Zoom", false)];
    expect(isIncompleteRivenRead(three, false, false)).toBe(true);
    expect(isIncompleteRivenRead(three, false, true)).toBe(false);
    expect(isIncompleteRivenRead([...three, stat("Toxin", true)], false, false)).toBe(false);
  });
});

describe("recognizeRivenCardStats completeness gate", () => {
  beforeEach(() => {
    recognizeStatAreaMock.mockReset();
    lowConfidenceMock.mockReset();
    lowConfidenceMock.mockImplementation(() => false);
  });

  it("returns an error instead of a card missing one of its buffs", async () => {
    const read = {
      lines: [
        { text: "+120.5% Damage", confidence: 0.99 },
        { text: "-72.3% Critical Chance", confidence: 0.99 },
      ],
      text: "+120.5% Damage\n-72.3% Critical Chance",
      minConfidence: 0.99,
      yoloBoxCount: 4,
    };
    recognizeStatAreaMock.mockResolvedValue(read);

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.stats).toEqual([]);
    expect(result.lowConfidence).toBe(true);
  });

  it("keeps a curse-free two-buff card when the crop caught a signed fragment", async () => {
    recognizeStatAreaMock.mockResolvedValue({
      lines: [
        { text: "Skana Acritor", confidence: 0.99 },
        { text: "+104.6% Critical Damage", confidence: 0.99 },
        { text: "+2.3 Range", confidence: 0.99 },
        { text: "+1 5%", confidence: 0.99 },
      ],
      text: "Skana Acritor\n+104.6% Critical Damage\n+2.3 Range\n+1 5%",
      minConfidence: 0.99,
      yoloBoxCount: 5,
    });

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.stats).toHaveLength(2);
    expect(result.lowConfidence).toBe(false);
  });

  const read = (...lines: string[]) => ({
    lines: lines.map((text) => ({ text, confidence: 0.99 })),
    text: lines.join("\n"),
    minConfidence: 0.99,
    yoloBoxCount: lines.length + 2,
  });
  const recognize = (rollReveal?: boolean) =>
    recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test", ...(rollReveal && { rollReveal }) },
    );

  // A still card retries a crop of the supplied frame on a missed title but must not
  // fail on it: the caller skips a recapture of a still card as the same frame.
  it("needs the title only on a roll capture, which can land mid-reveal", async () => {
    recognizeStatAreaMock.mockResolvedValue(
      read("+104.6% Critical Damage", "+2.3 Range", "-20.1% Zoom"),
    );

    expect((await recognize()).stats).toHaveLength(3);
    const roll = await recognize(true);
    expect(roll.stats).toEqual([]);
    expect(roll.lowConfidence).toBe(true);
  });

  it("lets a retry complete a roll read that only lacked its title", async () => {
    recognizeStatAreaMock
      .mockResolvedValueOnce(read("+104.6% Critical Damage", "+2.3 Range", "-20.1% Zoom"))
      .mockResolvedValueOnce(
        read("Skana Acritor", "+104.6% Critical Damage", "+2.3 Range", "-20.1% Zoom"),
      );

    expect((await recognize(true)).stats).toHaveLength(3);
  });

  it("lets a clean four-stat retry replace a read over both roll cards", async () => {
    const title = "Skana Acritor";
    const four = ["+104.6% Critical Damage", "+2.3 Range", "+50.2% Multishot", "-20.1% Zoom"];
    recognizeStatAreaMock
      .mockResolvedValueOnce(read(title, ...four, "+102% Electricity"))
      .mockResolvedValueOnce(read(title, ...four));

    const result = await recognize();
    expect(result.stats).toHaveLength(4);
    expect(result.lowConfidence).toBe(false);
  });

  // Chat-card Angstrum at native scale: the curse went unsigned and so unflagged.
  it("keeps the error when the retry silently lost the line the first read flagged", async () => {
    const title = "Angstrum Sati-";
    const buffs = ["+159% Multishot", "+276.2% Damage", "+93.2% Fire Rate"];
    recognizeStatAreaMock
      .mockResolvedValueOnce(read(title, ...buffs, "-90.9% Pjrcteee Sp"))
      .mockResolvedValueOnce(read(title, ...buffs, "90% Projectleee"));

    const lost = await recognize();
    expect(lost.stats).toEqual([]);
    expect(lost.lowConfidence).toBe(true);

    recognizeStatAreaMock
      .mockResolvedValueOnce(read(title, ...buffs, "-90.9% Pjrcteee Sp"))
      .mockResolvedValueOnce(read(title, ...buffs, "-90.9% Projectile Speed"));
    expect((await recognize()).stats).toHaveLength(4);
  });

  it("retries two buffs when the unread line carried a stat name too", async () => {
    recognizeStatAreaMock.mockResolvedValue({
      lines: [
        { text: "+104.6% Critical Damage", confidence: 0.99 },
        { text: "+2.3 Range", confidence: 0.99 },
        { text: "x1.36 Dmagt Grneea", confidence: 0.99 },
      ],
      text: "+104.6% Critical Damage\n+2.3 Range\nx1.36 Dmagt Grneea",
      minConfidence: 0.99,
      yoloBoxCount: 6,
    });

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.stats).toEqual([]);
    expect(result.lowConfidence).toBe(true);
  });
});
