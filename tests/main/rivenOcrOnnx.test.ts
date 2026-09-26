import { describe, expect, it } from "vitest";

import { parseRivenStats } from "../../ipc/overlay/rivenScanText";
import {
  hasLowConfidenceLine,
  LOW_CONFIDENCE_THRESHOLD,
  mergeSplitLines,
  recognizePaddleCrops,
  trimmedLineConfidence,
  type RgbCrop,
} from "../../services/rivenOcrOnnx";

async function wordCrop(word: string, width: number, height: number): Promise<RgbCrop> {
  const sharp = (await import("sharp")).default;
  const svg =
    `<svg width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="black"/>` +
    `<text x="6" y="${Math.round(height * 0.74)}" font-family="Arial" ` +
    `font-size="${Math.round(height * 0.6)}" fill="white">${word}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe("recognizePaddleCrops", () => {
  // Crops are regrouped by width before inference, so the batch order is not the
  // caller's order. A stat line read into the wrong row grades the wrong stat.
  it("returns a result per crop in the caller's order", async () => {
    const crops = await Promise.all([
      wordCrop("Sobek", 300, 48),
      wordCrop("Braton Braton Braton", 900, 26),
      wordCrop("Lex", 120, 60),
      wordCrop("Boar", 240, 40),
      wordCrop("Paris Paris", 520, 30),
      wordCrop("Kuva", 200, 52),
      wordCrop("Ogris", 260, 44),
      wordCrop("Latron Latron", 640, 34),
    ]);

    const batched = await recognizePaddleCrops(crops);
    expect(batched).toHaveLength(crops.length);

    const alone = [];
    for (const crop of crops) alone.push((await recognizePaddleCrops([crop]))[0]);
    expect(batched.map((row) => row.text)).toEqual(alone.map((row) => row.text));
    expect(batched.some((row) => row.text.length > 0)).toBe(true);
  }, 120_000);

  // Real riven captures produce text crops up to 59:1 while solid panel rules sit
  // at 27-37:1, so no aspect threshold can tell them apart. Wide text has to
  // survive intact, which rules out squeezing every crop to a fixed ratio.
  it("reads a wide text crop the same beside a wider blank one", async () => {
    const wide = await wordCrop("Kuva Sobek Boar Prime Paris Prime Latron", 1740, 30);
    expect(wide.width / wide.height).toBeGreaterThan(55);
    const rule: RgbCrop = { data: Buffer.alloc(1721 * 21 * 3, 235), width: 1721, height: 21 };

    const [alone] = await recognizePaddleCrops([wide]);
    expect(alone.text.length).toBeGreaterThan(0);

    const beside = await recognizePaddleCrops([wide, rule]);
    expect(beside).toHaveLength(2);
    expect(beside[0].text).toBe(alone.text);
  }, 120_000);

  it("skips a crop that busts the decode budget on its own", async () => {
    const good = await wordCrop("Sobek", 300, 48);
    const artifact: RgbCrop = { data: Buffer.alloc(3840 * 5 * 3, 235), width: 3840, height: 5 };

    const results = await recognizePaddleCrops([good, artifact]);
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({ text: "", confidence: 0 });
    expect(results[0].text.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("hasLowConfidenceLine", () => {
  const line = (text: string, confidence: number) => ({ text, confidence });
  const result = (lines: Array<{ text: string; confidence: number }>) => ({
    lines,
    text: lines.map((l) => l.text).join("\n"),
    minConfidence: Math.min(...lines.map((l) => l.confidence)),
    yoloBoxCount: lines.length,
  });

  it("ignores a garbled MR badge that happens to start with X", () => {
    // "X(m R9" once gated a perfect four-stat read at 0.92+.
    expect(
      hasLowConfidenceLine(
        result([
          line("+72.7% Fire Rate (X2 for", 0.93),
          line("-66.2% Weapon Recoil", 0.92),
          line("+85.7% Multishot", 0.94),
          line("-65,1% Status Duration", 0.92),
          line("X(m R9", 0.57),
        ]),
      ),
    ).toBe(false);
  });

  it("still gates low-confidence stat and multiplier lines", () => {
    expect(hasLowConfidenceLine(result([line("-66.2% Weapon Recoil", 0.7)]))).toBe(true);
    expect(hasLowConfidenceLine(result([line("x2 Combo Duration", 0.7)]))).toBe(true);
  });
});

// Single-card reads from the 263-screenshot benchmark, where a lone CJK glyph
// line sits between the two halves of a wrapped name.
describe("mergeSplitLines", () => {
  const read = (lines: Array<[string, number]>) =>
    mergeSplitLines(lines.map(([text, confidence]) => ({ text, confidence })));
  const stats = (lines: Array<[string, number]>) =>
    parseRivenStats(
      read(lines)
        .map((line) => line.text)
        .join("\n"),
    ).map((stat) => `${stat.value} ${stat.name}`);

  it("joins a wrapped name across the glyph line between its halves", () => {
    const heavy: Array<[string, number]> = [
      ["Hate Ignisus", 0.9271],
      ["+173,4% ( slash", 0.8698],
      ["+132% WHeat", 0.9007],
      ["-41,2% Heavy Attack", 0.93],
      ["北", 0.0391],
      ["Efficiency", 0.9011],
    ];
    expect(read(heavy).slice(3)).toEqual([
      { text: "-41,2% Heavy Attack Efficiency", confidence: 0.9011 },
    ]);
    expect(stats(heavy)).toEqual(["173.4 Slash", "132 Heat", "41.2 Heavy Attack Efficiency"]);
    expect(
      stats([
        ["Furis Heratin", 0.9219],
        ["+100,9% Zo0m", 0.9379],
        ["+60,2% Magazine", 0.955],
        ["和", 0.3573],
        ["Capacity", 0.9655],
      ]),
    ).toEqual(["100.9 Zoom", "60.2 Magazine Capacity"]);
    expect(
      stats([
        ["Boar Purabin", 0.9418],
        ["x1,63 Damage to Infested", 0.9652],
        ["+114,9% Ammo", 0.9064],
        ["江", 0.0653],
        ["Maximum", 0.8659],
      ]),
    ).toEqual(["1.63 Damage to Infested", "114.9 Ammo Maximum"]);
  });

  it("keeps a glyph line that splits no name", () => {
    const lines: Array<[string, number]> = [
      ["+104% Status Duration", 0.9864],
      ["北", 0.1157],
      ["x0,6 Damage to Corpus", 0.8994],
    ];
    expect(read(lines).map((line) => line.text)).toEqual(lines.map(([text]) => text));
  });

  // Per-box reads of the 192206 and 193114 crops: the stray "1" box once lent its
  // confidence to the merged line it is a substring of, which failed the gate.
  it("keeps each confidence on its own line after a merge", () => {
    const merged = read([
      ["Hate Locti-plecicta", 0.909],
      ["+89,6% Finisher Damage", 0.935],
      ["+102,4% Critical Chance", 0.941],
      ["for Slide Attack", 0.884],
      ["1", 0.118],
      ["+1,7Range", 0.865],
    ]);
    expect(merged.slice(2)).toEqual([
      { text: "+102,4% Critical Chance for Slide Attack", confidence: 0.884 },
      { text: "1", confidence: 0.118 },
      { text: "+1,7Range", confidence: 0.865 },
    ]);
    const ammo = read([
      ["Boar Toxibin", 0.866],
      ["+108,4% Ammo", 0.935],
      ["Maximum", 0.957],
      ["1", 0.137],
      ["+108,5% :Toxin", 0.936],
    ]);
    for (const lines of [merged, ammo]) {
      const text = lines.map((line) => line.text).join("\n");
      const confidences = lines.map((line) => line.confidence);
      const result = { lines, text, minConfidence: Math.min(...confidences), yoloBoxCount: 6 };
      expect(hasLowConfidenceLine(result)).toBe(false);
    }
  });
});

describe("trimmedLineConfidence", () => {
  const read = (text: string, charConfidences: number[]) => ({
    text,
    confidence: 0,
    charConfidences,
  });

  // Per-glyph confidences of benchmark card 192421 (owner-checked +167.3 Impact).
  it("leaves the element icon after the value out of the line confidence", () => {
    const impact = read(
      "+167,3% 入lmpact ",
      [
        0.7618, 0.5309, 0.8544, 0.992, 0.821, 0.7718, 0.9932, 0.6968, 0.595, 0.3912, 0.9983, 0.998,
        0.9983, 0.5947, 0.9896, 0.5037,
      ],
    );
    expect(trimmedLineConfidence(impact)).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
  });

  it("still counts glyphs that stand in for letters of the stat name", () => {
    const confs = [0.9, 0.9, 0.9, 0.9, 0.9, 0.2, 0.2, 0.9, 0.9, 0.9];
    expect(trimmedLineConfidence(read("+45% 入入eat", confs))).toBeCloseTo(7.6 / 10, 6);
  });

  it("still counts a glyph read inside the value", () => {
    const confs = [0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
    expect(trimmedLineConfidence(read("+1入7,3% Impact", confs))).toBeCloseTo(11.8 / 14, 6);
  });
});
