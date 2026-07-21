import type { NativeImage } from "electron";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  binarizeRewardRegion,
  detectConsoleOpen,
  detectGameContentRect,
  detectRewardSlotLayoutCandidates,
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
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
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
});
