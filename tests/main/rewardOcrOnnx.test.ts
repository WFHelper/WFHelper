import { describe, expect, it } from "vitest";

import { cleanOnnxRowText, splitStripRows } from "../../services/rewardOcrOnnx";

// mono buffer builder: 255 background, `ink` leading dark pixels per row in each range
function makeMono(
  width: number,
  height: number,
  rowRanges: Array<{ from: number; to: number; ink: number }>,
): Uint8Array {
  const mono = new Uint8Array(width * height).fill(255);
  for (const range of rowRanges) {
    for (let y = range.from; y <= range.to; y++) {
      for (let x = 0; x < range.ink; x++) mono[y * width + x] = 0;
    }
  }
  return mono;
}

describe("splitStripRows", () => {
  it("finds a single text row", () => {
    const mono = makeMono(300, 132, [{ from: 40, to: 95, ink: 30 }]);
    const segs = splitStripRows(mono, 300, 132);
    expect(segs).toHaveLength(1);
    expect(segs[0].y1).toBe(40);
    expect(segs[0].y2).toBe(95);
  });

  it("finds two wrapped rows separated by a gap", () => {
    const mono = makeMono(300, 132, [
      { from: 10, to: 62, ink: 30 },
      { from: 70, to: 122, ink: 30 },
    ]);
    const segs = splitStripRows(mono, 300, 132);
    expect(segs).toHaveLength(2);
    expect(segs[0].y2).toBeLessThan(segs[1].y1);
  });

  it("force-splits a merged over-tall blob at the ink valley", () => {
    // two lines bridged by faint valley rows: projection alone sees one segment
    const mono = makeMono(300, 132, [
      { from: 5, to: 60, ink: 30 },
      { from: 61, to: 68, ink: 5 },
      { from: 69, to: 125, ink: 30 },
    ]);
    const segs = splitStripRows(mono, 300, 132);
    expect(segs).toHaveLength(2);
  });

  it("drops sub-minimum noise specks", () => {
    const mono = makeMono(300, 132, [
      { from: 2, to: 5, ink: 30 },
      { from: 60, to: 110, ink: 30 },
    ]);
    const segs = splitStripRows(mono, 300, 132);
    expect(segs).toHaveLength(1);
    expect(segs[0].y1).toBe(60);
  });

  it("ignores rows with ink below the width-relative floor", () => {
    const mono = makeMono(300, 132, [{ from: 40, to: 95, ink: 2 }]);
    expect(splitStripRows(mono, 300, 132)).toHaveLength(0);
  });
});

describe("cleanOnnxRowText", () => {
  it("restores word spaces at case boundaries", () => {
    expect(cleanOnnxRowText("BratonPrimeStockTrumna")).toBe("Braton Prime Stock Trumna");
    expect(cleanOnnxRowText("tilusPrimeSystems")).toBe("tilus Prime Systems");
  });

  it("strips non-ascii decode artifacts", () => {
    expect(cleanOnnxRowText("、· 2 X Forma Blueprint")).toBe("2 X Forma Blueprint");
    expect(cleanOnnxRowText("一——二 Epitaph Prime Receiver")).toBe(
      "Epitaph Prime Receiver",
    );
  });

  it("keeps ampersands and already-spaced names", () => {
    expect(cleanOnnxRowText("Cobra & Crane Prime Blueprint")).toBe("Cobra & Crane Prime Blueprint");
    expect(cleanOnnxRowText("Wukong Prime Chassis")).toBe("Wukong Prime Chassis");
  });
});
