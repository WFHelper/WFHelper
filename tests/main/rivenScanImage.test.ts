import type { NativeImage } from "electron";
import { describe, expect, it } from "vitest";

import { cropRivenStatImage, RIVEN_SCAN_CROPS } from "../../ipc/overlay/rivenScanImage";

// Minimal structural NativeImage over a BGRA buffer; crop returns another fake
// so nested crops (rough -> aspect trim -> stat band) work.
function wrapImage(bitmap: Buffer, width: number, height: number): NativeImage {
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
    isEmpty: () => false,
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const cropped = Buffer.alloc(rect.width * rect.height * 4);
      for (let cy = 0; cy < rect.height; cy++) {
        const srcStart = ((rect.y + cy) * width + rect.x) * 4;
        bitmap.copy(cropped, cy * rect.width * 4, srcStart, srcStart + rect.width * 4);
      }
      return wrapImage(cropped, rect.width, rect.height);
    },
  } as unknown as NativeImage;
}

const SCREEN_W = 2560;
const SCREEN_H = 1440;
const TEXT_W = 340;
// Stat text rows sit inside the stat band of the rough singleCard crop
// (screen y 839..1163 at 1440p).
const TEXT_TOP = 880;
const TEXT_BOTTOM = 1160;

/** Dark screen with white "stat line" stripes starting at textLeft. */
function makeRivenScreen(textLeft: number): NativeImage {
  const bitmap = Buffer.alloc(SCREEN_W * SCREEN_H * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 30;
    bitmap[i + 1] = 30;
    bitmap[i + 2] = 30;
    bitmap[i + 3] = 255;
  }
  for (let y = TEXT_TOP; y < TEXT_BOTTOM; y++) {
    if ((y - TEXT_TOP) % 28 >= 16) continue; // 16px text line, 12px gap
    for (let x = textLeft; x < textLeft + TEXT_W; x++) {
      const idx = (y * SCREEN_W + x) * 4;
      bitmap[idx] = 255;
      bitmap[idx + 1] = 255;
      bitmap[idx + 2] = 255;
    }
  }
  return wrapImage(bitmap, SCREEN_W, SCREEN_H);
}

/** Width of the white text span found in a crop (0 when absent). */
function whiteSpan(image: NativeImage): number {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let minX = -1;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (bitmap[idx] > 200 && bitmap[idx + 1] > 200 && bitmap[idx + 2] > 200) {
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return minX < 0 ? 0 : maxX - minX + 1;
}

describe("cropRivenStatImage", () => {
  it("keeps the full text column when the card is centered", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });

  it("keeps the full text column when the card sits 150px left of center", () => {
    // Letterbox shaving on dark scenes shifts the card within the rough crop.
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2 - 150);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });

  it("falls back to the geometric center when no text is found", () => {
    const bitmap = Buffer.alloc(SCREEN_W * SCREEN_H * 4, 30);
    const screen = wrapImage(bitmap, SCREEN_W, SCREEN_H);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    const { width, height } = statCrop.getSize();
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(100);
  });

  it("recovers an off-center card in the widened roll crop", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2 - 120);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.rollCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });
});
