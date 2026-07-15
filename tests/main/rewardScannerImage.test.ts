import type { NativeImage } from "electron";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { binarizeRewardRegion, detectConsoleOpen } from "../../services/rewardScannerImage";
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
