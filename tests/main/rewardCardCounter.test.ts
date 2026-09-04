import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  countRewardCardsInBitmap,
  detectRewardSlotLayoutCandidates,
} from "../../services/rewardScannerImage";
import type { NativeImage } from "electron";

import { REFERENCE_WARFRAME_UI_SCALE } from "../../config/runtime/overlaySettings";

const REFERENCE_SCALE = { scaleX: 1, scaleY: 1 };
const FIXTURE_DIR = path.resolve(__dirname, "../../scripts/reward-scan-e2e/fixtures/screens");

// Card centres for each choice count: 0.122W-wide cards on a 0.127W pitch about x=0.5.
function cardLefts(count: number): number[] {
  const pitch = 0.127;
  const first = 0.5 - (count * pitch - 0.005) / 2;
  return Array.from({ length: count }, (_, i) => first + i * pitch);
}

// A frame with N cards: dark noisy backdrop, each card a flat panel with the
// thin bright bar under its title, as the real screen draws it.
function frameWithCards(width: number, height: number, count: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 9;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const n = noise();
      bitmap[idx] = 14 + n;
      bitmap[idx + 1] = 12 + n;
      bitmap[idx + 2] = 10 + n;
      bitmap[idx + 3] = 255;
    }
  }
  for (const left of cardLefts(count)) {
    const x0 = Math.round(left * width);
    const x1 = Math.round((left + 0.122) * width);
    for (let y = Math.round(0.225 * height); y < Math.round(0.47 * height); y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        bitmap[idx] = 38;
        bitmap[idx + 1] = 34;
        bitmap[idx + 2] = 30;
      }
    }
    const barTop = Math.round(0.443 * height);
    for (let y = barTop; y < barTop + Math.max(2, Math.round(0.004 * height)); y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        bitmap[idx] = 210;
        bitmap[idx + 1] = 200;
        bitmap[idx + 2] = 190;
      }
    }
  }
  return bitmap;
}

async function loadFixture(
  name: string,
  cropTop = 0,
): Promise<{ bitmap: Buffer; width: number; height: number } | null> {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) return null;
  const meta = await sharp(file).metadata();
  const { data, info } = await sharp(file)
    .extract({
      left: 0,
      top: cropTop,
      width: meta.width ?? 0,
      height: (meta.height ?? 0) - cropTop,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // sharp hands back RGBA; the detector reads BGRA like nativeImage.toBitmap().
  const bitmap = Buffer.from(data);
  for (let i = 0; i < bitmap.length; i += 4) {
    const r = bitmap[i];
    bitmap[i] = bitmap[i + 2];
    bitmap[i + 2] = r;
  }
  return { bitmap, width: info.width, height: info.height };
}

function aspectScale(width: number, height: number) {
  const referenceWidth = (height * 16) / 9;
  const referenceHeight = (width * 9) / 16;
  return {
    scaleX: referenceWidth < width ? referenceWidth / width : 1,
    scaleY: referenceHeight < height ? referenceHeight / height : 1,
  };
}

describe("countRewardCardsInBitmap", () => {
  it.each([1, 2, 3, 4])("counts %i synthetic cards at 1080p", (count) => {
    const bitmap = frameWithCards(1920, 1080, count);
    expect(countRewardCardsInBitmap(bitmap, 1920, 1080, 1, REFERENCE_SCALE)).toBe(count);
  });

  it("counts four synthetic cards at 1440p", () => {
    const bitmap = frameWithCards(2560, 1440, 4);
    expect(countRewardCardsInBitmap(bitmap, 2560, 1440, 1, REFERENCE_SCALE)).toBe(4);
  });

  it("reports no cards on a blank frame", () => {
    const bitmap = frameWithCards(1920, 1080, 0);
    expect(countRewardCardsInBitmap(bitmap, 1920, 1080, 1, REFERENCE_SCALE)).toBe(0);
  });

  // Real full-screen captures live outside git (player names), so a missing one has to
  // show up as a skip; returning early once let the real-screen half report green with no
  // fixtures. The 1080x607 capture is a 1080p screen at 56%: its bar is under a pixel tall,
  // so the counter reports 0 and the layout search takes over.
  const REAL_SCREENS = [
    { name: "real-full-2p.png", expected: 2, cropTop: 0 },
    { name: "real-full-4p-fps.png", expected: 4, cropTop: 0 },
    { name: "real-full-4p-16x10.png", expected: 4, cropTop: 0 },
    { name: "real-full-4p-1080x607.png", expected: 0, cropTop: 0 },
    // Older squad-row UI: the counter finds no bar in the band it probes, so the
    // layout search answers this frame. Pinned as it behaves today.
    { name: "real-full-4p-oldui90.png", expected: 0, cropTop: 0 },
    // Windowed captures carry a 23px title bar the live app crops away.
    { name: "real-full-1p-windowed.png", expected: 1, cropTop: 23 },
    { name: "real-full-1p-windowed-fang.png", expected: 1, cropTop: 23 },
  ];

  for (const { name, expected, cropTop } of REAL_SCREENS) {
    const absent = !fs.existsSync(path.join(FIXTURE_DIR, name));
    it.skipIf(absent)(`counts ${expected} card(s) on ${name} (local-only fixture)`, async () => {
      const frame = await loadFixture(name, cropTop);
      if (!frame) throw new Error(`fixture vanished between collection and run: ${name}`);
      const scale = aspectScale(frame.width, frame.height);
      expect(countRewardCardsInBitmap(frame.bitmap, frame.width, frame.height, 1, scale)).toBe(
        expected,
      );
    });
  }
});

describe("detectRewardSlotLayoutCandidates with counted cards", () => {
  function fakeImage(bitmap: Buffer, width: number, height: number): NativeImage {
    return {
      getSize: () => ({ width, height }),
      toBitmap: () => bitmap,
      isEmpty: () => false,
      crop: () => {
        throw new Error("a counted frame must not sample slot activity");
      },
    } as unknown as NativeImage;
  }

  it("returns the counted layout alone and skips the activity ranking", () => {
    const image = fakeImage(frameWithCards(1920, 1080, 3), 1920, 1080);
    const layouts = detectRewardSlotLayoutCandidates(image, REFERENCE_WARFRAME_UI_SCALE);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ count: 3, confidence: 1, counted: true });
    expect(layouts[0].slots).toHaveLength(3);
    expect(layouts[0].slots[0].x).toBeCloseTo(0.312, 3);
  });
});
