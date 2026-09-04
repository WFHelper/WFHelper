import type { NativeImage } from "electron";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  binarizeRewardRegion,
  canvasContentRect,
  cropBand,
  detectConsoleOpen,
  detectGameContentRect,
  detectRewardSlotLayoutCandidates,
  sampleRewardCardBand,
} from "../../services/rewardScannerImage";
import { resetFrameDedup } from "../../services/rewardScanner";

function makeFakeNativeImage(
  width: number,
  height: number,
  fillFn: (x: number, y: number) => [number, number, number, number],
) {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [b, g, r, a] = fillFn(x, y);
      const idx = (y * width + x) * 4;
      bitmap[idx] = b;
      bitmap[idx + 1] = g;
      bitmap[idx + 2] = r;
      bitmap[idx + 3] = a;
    }
  }
  return {
    getSize: () => ({ width, height }),
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const cw = rect.width;
      const ch = rect.height;
      const cropped = Buffer.alloc(cw * ch * 4);
      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          const srcIdx = ((rect.y + cy) * width + (rect.x + cx)) * 4;
          const dstIdx = (cy * cw + cx) * 4;
          cropped[dstIdx] = bitmap[srcIdx];
          cropped[dstIdx + 1] = bitmap[srcIdx + 1];
          cropped[dstIdx + 2] = bitmap[srcIdx + 2];
          cropped[dstIdx + 3] = bitmap[srcIdx + 3];
        }
      }
      return {
        getSize: () => ({ width: cw, height: ch }),
        toBitmap: () => cropped,
        isEmpty: () => false,
      };
    },
    toBitmap: () => bitmap,
    isEmpty: () => false,
  } as unknown as NativeImage;
}

describe("detectConsoleOpen", () => {
  it("returns false for null/invalid input", () => {
    expect(detectConsoleOpen(null as never)).toBe(false);
    expect(detectConsoleOpen(undefined as never)).toBe(false);
    expect(detectConsoleOpen({} as never)).toBe(false);
  });

  it("returns true when bottom strip is bright and low saturation (console open)", () => {
    // Simulate a 400x200 frame with a bright white bar at the bottom 4%
    const img = makeFakeNativeImage(400, 200, (_x, y) => {
      if (y >= 192) {
        // Bottom 4%: bright white (low sat, high lum)
        return [230, 230, 230, 255]; // BGR
      }
      // Dark gameplay area
      return [20, 20, 20, 255];
    });
    expect(detectConsoleOpen(img)).toBe(true);
  });

  it("returns false when bottom strip is dark (normal gameplay)", () => {
    const img = makeFakeNativeImage(400, 200, () => {
      return [30, 30, 30, 255]; // dark everywhere
    });
    expect(detectConsoleOpen(img)).toBe(false);
  });

  it("returns false when bottom strip is colorful (not console)", () => {
    // Bottom is bright but saturated (e.g. colored UI element, not console)
    const img = makeFakeNativeImage(400, 200, (_x, y) => {
      if (y >= 192) {
        return [200, 40, 40, 255]; // bright blue, highly saturated
      }
      return [30, 30, 30, 255];
    });
    expect(detectConsoleOpen(img)).toBe(false);
  });

  it("returns false for tiny images", () => {
    const img = makeFakeNativeImage(50, 50, () => [230, 230, 230, 255]);
    expect(detectConsoleOpen(img)).toBe(false);
  });

  it("returns false on a light UI theme, where the whole frame is bright", () => {
    // Orokin-style theme: the bottom strip is bright, but so is everything else.
    const img = makeFakeNativeImage(400, 200, (_x, y) =>
      y >= 192 ? [200, 200, 200, 255] : [190, 190, 190, 255],
    );
    expect(detectConsoleOpen(img)).toBe(false);
  });

  it("still spots a console bar on a light UI theme", () => {
    const img = makeFakeNativeImage(400, 200, (_x, y) =>
      y >= 192 ? [248, 248, 248, 255] : [150, 150, 150, 255],
    );
    expect(detectConsoleOpen(img)).toBe(true);
  });
});

describe("detectGameContentRect", () => {
  const BRIGHT: [number, number, number, number] = [160, 160, 160, 255];
  const BLACK: [number, number, number, number] = [4, 4, 4, 255];

  it("returns the full frame when nothing is black", () => {
    const img = makeFakeNativeImage(480, 270, () => BRIGHT);
    expect(detectGameContentRect(img)).toEqual({ x: 0, y: 0, width: 480, height: 270 });
  });

  it("keeps a symmetric pillarbox (16:9 content on a wider frame)", () => {
    const img = makeFakeNativeImage(480, 270, (x) => (x < 60 || x >= 420 ? BLACK : BRIGHT));
    expect(detectGameContentRect(img)).toEqual({ x: 60, y: 0, width: 360, height: 270 });
  });

  it("keeps a symmetric letterbox (top/bottom bars)", () => {
    const img = makeFakeNativeImage(480, 270, (_x, y) => (y < 30 || y >= 240 ? BLACK : BRIGHT));
    expect(detectGameContentRect(img)).toEqual({ x: 0, y: 30, width: 480, height: 210 });
  });

  it("rejects a one-sided dark scene edge (riven roll screen regression)", () => {
    // Saturated left scan + thin right edge = dark scene, not a pillarbox.
    const img = makeFakeNativeImage(480, 270, (x) => (x < 120 || x >= 476 ? BLACK : BRIGHT));
    expect(detectGameContentRect(img)).toEqual({ x: 4, y: 0, width: 472, height: 270 });
  });

  it("rejects a one-sided dark scene band at the top", () => {
    const img = makeFakeNativeImage(480, 270, (_x, y) => (y < 60 ? BLACK : BRIGHT));
    expect(detectGameContentRect(img)).toEqual({ x: 0, y: 0, width: 480, height: 270 });
  });
});

describe("canvasContentRect", () => {
  const BRIGHT: [number, number, number, number] = [160, 160, 160, 255];
  const BLACK: [number, number, number, number] = [4, 4, 4, 255];

  it("is identity on a 16:9 frame", () => {
    const img = makeFakeNativeImage(480, 270, () => BRIGHT);
    expect(canvasContentRect(img)).toEqual({ x: 0, y: 0, width: 480, height: 270 });
  });

  it("clamps a barless 16:10 render to the centred 16:9 canvas", () => {
    const img = makeFakeNativeImage(480, 300, () => BRIGHT);
    expect(canvasContentRect(img)).toEqual({ x: 0, y: 15, width: 480, height: 270 });
  });

  it("matches the bar-trimmed rect when the same frame is letterboxed", () => {
    const img = makeFakeNativeImage(480, 300, (_x, y) => (y < 15 || y >= 285 ? BLACK : BRIGHT));
    expect(canvasContentRect(img)).toEqual({ x: 0, y: 15, width: 480, height: 270 });
  });

  it("clamps a barless ultrawide render to the centred 16:9 canvas", () => {
    const img = makeFakeNativeImage(480, 216, () => BRIGHT);
    expect(canvasContentRect(img)).toEqual({ x: 48, y: 0, width: 384, height: 216 });
  });
});

describe("resetFrameDedup", () => {
  it("returns undefined and is a safe, idempotent reset", () => {
    // dedup cache is private; just pin that reset is a safe, repeatable no-op
    expect(resetFrameDedup()).toBeUndefined();
    expect(() => {
      resetFrameDedup();
      resetFrameDedup();
    }).not.toThrow();
  });
});

async function makeStripPng(bg: number, fg: number): Promise<Buffer> {
  // 120x24 strip with four 10x12 "glyph" blocks - no fonts or OCR needed
  const width = 120;
  const height = 24;
  const raw = Buffer.alloc(width * height * 4);
  const blocks = [10, 40, 70, 100];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBlock = y >= 6 && y < 18 && blocks.some((bx) => x >= bx && x < bx + 10);
      const v = inBlock ? fg : bg;
      const i = (y * width + x) * 4;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function binarizedSamples(png: Buffer): Promise<{ glyphs: number[]; background: number[] }> {
  const out = await binarizeRewardRegion(png, 0, 1);
  expect(out).not.toBeNull();
  const { data, info } = await sharp(out!).raw().toBuffer({ resolveWithObject: true });
  // binarize upscales 3x; sample block centers to dodge resampling ringing
  const px = (x: number, y: number): number => data[(y * info.width + x) * info.channels];
  return {
    glyphs: [15, 45, 75, 105].map((x) => px(x * 3, 12 * 3)),
    background: [30, 60, 90].map((x) => px(x * 3, 12 * 3)),
  };
}

describe("detectRewardSlotLayoutCandidates aspect handling", () => {
  // Bright band across the reward-card row so every fixed layout sees activity.
  function frameWithRewardRow(width: number, height: number) {
    return makeFakeNativeImage(width, height, (x, y) => {
      const inRow = y >= height * 0.2 && y <= height * 0.47;
      const inCards = x >= width * 0.2 && x <= width * 0.8;
      return inRow && inCards ? [230, 230, 230, 255] : [8, 8, 8, 255];
    });
  }

  function fourSlotLayout(width: number, height: number) {
    const layout = detectRewardSlotLayoutCandidates(frameWithRewardRow(width, height)).find(
      (candidate) => candidate.count === 4,
    );
    expect(layout).toBeDefined();
    return layout!;
  }

  it("leaves the measured 16:9 ratios untouched on a 16:9 frame", () => {
    const { slots } = fourSlotLayout(1920, 1080);
    expect(slots[0].x).toBeCloseTo(0.245, 3);
    expect(slots[0].width).toBeCloseTo(0.122, 3);
    expect(slots[3].x).toBeCloseTo(0.626, 3);
  });

  it("narrows and re-centres the cards on a 21:9 frame", () => {
    const scale = (1440 * (16 / 9)) / 3440;
    const { slots } = fourSlotLayout(3440, 1440);
    expect(slots[0].x).toBeCloseTo(0.5 + (0.245 - 0.5) * scale, 3);
    expect(slots[0].width).toBeCloseTo(0.122 * scale, 3);
    // Outer card must not spill into its neighbour - that killed slots 1 and 4.
    const last = slots[3];
    expect(last.x + last.width).toBeCloseTo(0.5 + (0.626 + 0.122 - 0.5) * scale, 3);
  });

  it("scales card geometry around the screen centre for the configured Warframe UI scale", () => {
    const layout = detectRewardSlotLayoutCandidates(frameWithRewardRow(1920, 1080), 0.75).find(
      (candidate) => candidate.count === 4,
    );
    expect(layout).toBeDefined();
    // Hand-derived from the 4-slot layout at 75% of the 99% reference scale, so
    // an inverted or misapplied ratio cannot satisfy these numbers.
    expect(layout!.slots[0].x).toBeCloseTo(0.3068, 3);
    expect(layout!.slots[0].y).toBeCloseTo(0.2917, 3);
    expect(layout!.slots[0].width).toBeCloseTo(0.0924, 3);
    expect(layout!.slots[0].height).toBeCloseTo(0.1705, 3);
    // A smaller in-game scale shrinks the cards toward the centre.
    const unscaled = detectRewardSlotLayoutCandidates(frameWithRewardRow(1920, 1080)).find(
      (candidate) => candidate.count === 4,
    );
    expect(unscaled!.slots[0].x).toBeCloseTo(0.245, 3);
    expect(layout!.slots[0].x).toBeGreaterThan(unscaled!.slots[0].x);
    expect(layout!.slots[0].width).toBeLessThan(unscaled!.slots[0].width);
  });
});

describe("cropBand aspect handling", () => {
  const BAND = { top: 0.16, height: 0.12 };
  const flat = (w: number, h: number) =>
    makeFakeNativeImage(w, h, () => [8, 8, 8, 255] as [number, number, number, number]);

  it("crops the measured ratios on a 16:9 frame", () => {
    const crop = cropBand(flat(1920, 1080), BAND);
    expect(crop.getSize()).toEqual({ width: 1920, height: Math.floor(1080 * 0.12) });
  });

  type Rect = { x: number; y: number; width: number; height: number };

  function bandCropRect(width: number, height: number): Rect {
    const image = flat(width, height);
    let cropRect: Rect | null = null;
    const original = image.crop.bind(image);
    image.crop = (rect: Rect) => {
      cropRect = rect;
      return original(rect);
    };
    cropBand(image, BAND);
    return cropRect!;
  }

  // Where the letterboxed 16:9 canvas puts the band inside a taller frame.
  function expectedBand(width: number, height: number): { y: number; height: number } {
    const canvasHeight = width / (16 / 9);
    const canvasTop = (height - canvasHeight) / 2;
    return {
      y: Math.floor(canvasTop + canvasHeight * BAND.top),
      height: Math.floor(canvasHeight * BAND.height),
    };
  }

  it("maps the band onto the centred 16:9 canvas of a 16:10 frame", () => {
    // The 16:9 canvas sits at y=60..1140 inside a 1200px-tall frame, so the
    // era text lands 40px lower than the raw ratio puts it, not the 60 of the offset.
    const crop = bandCropRect(1920, 1200);
    expect(crop.y).toBe(expectedBand(1920, 1200).y);
    expect(crop.y).not.toBe(Math.floor(1200 * BAND.top));
  });

  it("maps the band onto the centred 16:9 canvas of a 4:3 frame", () => {
    // 4:3 letterboxes hardest: an 810px canvas in a 1080px frame, so the band
    // sits well below the raw ratio and is a quarter shorter.
    const crop = bandCropRect(1440, 1080);
    const expected = expectedBand(1440, 1080);
    expect(crop.y).toBe(expected.y);
    expect(crop.height).toBe(expected.height);
    expect(crop.y).not.toBe(Math.floor(1080 * BAND.top));
    expect(crop.height).not.toBe(Math.floor(1080 * BAND.height));
  });
});

describe("binarizeRewardRegion", () => {
  it("renders bright text on a dark strip as dark-on-white", async () => {
    const { glyphs, background } = await binarizedSamples(await makeStripPng(20, 240));
    for (const value of glyphs) expect(value).toBe(0);
    for (const value of background) expect(value).toBe(255);
  });

  it("renders bright text on a BRIGHT strip as dark-on-white (names over bright art)", async () => {
    const { glyphs, background } = await binarizedSamples(await makeStripPng(170, 240));
    for (const value of glyphs) expect(value).toBe(0);
    for (const value of background) expect(value).toBe(255);
  });

  it("renders DARK text on a light strip as dark-on-white (light UI theme)", async () => {
    const { glyphs, background } = await binarizedSamples(await makeStripPng(235, 25));
    for (const value of glyphs) expect(value).toBe(0);
    for (const value of background) expect(value).toBe(255);
  });
});

describe("sampleRewardCardBand", () => {
  // Cards live in y 0.225-0.45; the void backdrop above and below animates.
  const cardRow = (y: number, height: number) => y > height * 0.25 && y < height * 0.4;

  it("ignores pixels outside the card band", () => {
    const base = makeFakeNativeImage(1920, 1080, (x, y) =>
      cardRow(y, 1080) ? [200, 200, 200, 255] : [10, 10, 10, 255],
    );
    const backdropChanged = makeFakeNativeImage(1920, 1080, (x, y) =>
      cardRow(y, 1080) ? [200, 200, 200, 255] : [x % 7 === 0 ? 90 : 10, 10, 10, 255],
    );
    const a = sampleRewardCardBand(base, 1);
    const b = sampleRewardCardBand(backdropChanged, 1);
    expect(a).not.toBeNull();
    expect(a!.equals(b!)).toBe(true);
  });

  it("changes when a card inside the band changes", () => {
    const base = makeFakeNativeImage(1920, 1080, (x, y) =>
      cardRow(y, 1080) ? [200, 200, 200, 255] : [10, 10, 10, 255],
    );
    // Green channel of the fourth card's title, which is what the sample reads.
    const fourthCard = makeFakeNativeImage(1920, 1080, (x, y) =>
      cardRow(y, 1080) && x > 1920 * 0.63 && x < 1920 * 0.74
        ? [200, 40, 200, 255]
        : cardRow(y, 1080)
          ? [200, 200, 200, 255]
          : [10, 10, 10, 255],
    );
    const a = sampleRewardCardBand(base, 1);
    const b = sampleRewardCardBand(fourthCard, 1);
    expect(a!.equals(b!)).toBe(false);
  });

  it("returns null for an empty frame", () => {
    expect(
      sampleRewardCardBand(
        makeFakeNativeImage(4, 4, () => [0, 0, 0, 255]),
        1,
      ),
    ).toBeNull();
  });
});
