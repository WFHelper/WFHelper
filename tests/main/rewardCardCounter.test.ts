import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  countRewardCardsInBitmap,
  detectRewardSlotLayoutCandidates,
  findRewardCardsInBitmap,
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

interface LegacyDraw {
  menuScale: number;
  barTop: number;
  barRows: number;
}

// Legacy menu scale (EE.cfg DSM_MATCH_SCREEN) keeps a fixed pixel size on real
// 1920x1080 and 2560x1440 screens: bar pitch about 202 px, bars 3 px tall with the
// top row 52-53 px above the frame centre, fading in over the outer eighth of each card.
function legacyAt(width: number, height: number): LegacyDraw {
  return {
    menuScale: 202 / (0.127 * width),
    barTop: Math.round(height / 2) - 53,
    barRows: 3,
  };
}

// A frame with N cards: dark noisy backdrop, each card a flat panel with the
// thin bright bar under its title, as the real screen draws it.
function frameWithCards(width: number, height: number, count: number, legacy?: LegacyDraw): Buffer {
  const menuScale = legacy?.menuScale ?? 1;
  const at = (ratio: number) => 0.5 + (ratio - 0.5) * menuScale;
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
    const x0 = Math.round(at(left) * width);
    const x1 = Math.round(at(left + 0.122) * width);
    for (let y = Math.round(at(0.225) * height); y < Math.round(at(0.47) * height); y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        bitmap[idx] = 38;
        bitmap[idx + 1] = 34;
        bitmap[idx + 2] = 30;
      }
    }
    const barTop = legacy?.barTop ?? Math.round(at(0.443) * height);
    const rows = legacy?.barRows ?? Math.max(2, Math.round(0.004 * height));
    for (let y = barTop; y < barTop + rows; y++) {
      for (let x = x0; x < x1; x++) {
        const fromEdge = Math.min(x - x0, x1 - 1 - x) / ((x1 - x0) / 8);
        const shade = legacy ? 0.6 + 0.4 * Math.min(1, fromEdge) : 1;
        const idx = (y * width + x) * 4;
        bitmap[idx] = Math.round(210 * shade);
        bitmap[idx + 1] = Math.round(200 * shade);
        bitmap[idx + 2] = Math.round(190 * shade);
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

  // Real full-screen captures live outside git (player names), so a missing one must
  // skip rather than pass silently. The 1080x607 capture is a 1080p screen at 56%: its
  // bar is under a pixel tall, so the counter reports 0 and the layout search takes over.
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

describe("findRewardCardsInBitmap", () => {
  it("keeps the configured scale when its bars are found", () => {
    const bitmap = frameWithCards(1920, 1080, 4);
    expect(findRewardCardsInBitmap(bitmap, 1920, 1080, 1, REFERENCE_SCALE)).toEqual({
      count: 4,
      uiScale: 1,
    });
  });

  const LEGACY_SCREENS = [1, 2, 3, 4].flatMap((count) => [
    { count, width: 1920, height: 1080 },
    { count, width: 2560, height: 1440 },
    { count, width: 3840, height: 2160 },
  ]);

  it.each(LEGACY_SCREENS)(
    "finds $count Legacy-scale card(s) at $width x $height",
    ({ count, width, height }) => {
      const legacy = legacyAt(width, height);
      const bitmap = frameWithCards(width, height, count, legacy);
      expect(
        countRewardCardsInBitmap(
          bitmap,
          width,
          height,
          REFERENCE_WARFRAME_UI_SCALE,
          REFERENCE_SCALE,
        ),
      ).toBe(0);
      const found = findRewardCardsInBitmap(
        bitmap,
        width,
        height,
        REFERENCE_WARFRAME_UI_SCALE,
        REFERENCE_SCALE,
      );
      expect(found.count).toBe(count);
      expect(Math.abs(found.uiScale / REFERENCE_WARFRAME_UI_SCALE - legacy.menuScale)).toBeLessThan(
        0.03,
      );
    },
  );

  it.each([
    [1920, 1080, 1, 0.9],
    [2560, 1440, 1, 0.7],
    [1920, 1080, 2, 0.78],
  ])(
    "keeps a %ix%i custom-scale screen (%i cards at %f) off the Legacy size",
    (width, height, count, real) => {
      const menuScale = real / REFERENCE_WARFRAME_UI_SCALE;
      const bitmap = frameWithCards(width, height, count, {
        menuScale,
        barTop: Math.round((0.5 + (0.443 - 0.5) * menuScale) * height),
        barRows: Math.max(2, Math.round(0.004 * height)),
      });
      const found = findRewardCardsInBitmap(bitmap, width, height, 0.5, REFERENCE_SCALE);
      expect(found.count).toBe(count);
      expect(Math.abs(found.uiScale - real)).toBeLessThanOrEqual(0.02);
    },
  );

  it("finds four Legacy-scale cards at 5120x2880", () => {
    const legacy = legacyAt(5120, 2880);
    const bitmap = frameWithCards(5120, 2880, 4, legacy);
    const found = findRewardCardsInBitmap(bitmap, 5120, 2880, 0.8, REFERENCE_SCALE);
    expect(found.count).toBe(4);
    expect(Math.abs(found.uiScale / REFERENCE_WARFRAME_UI_SCALE - legacy.menuScale)).toBeLessThan(
      0.03,
    );
  });

  it("finds the 2 px bars of the Legacy screen at its 2000x1122 capture size", () => {
    // A 2560x1440 capture scaled down keeps its fractions, not the fixed pixel size.
    const bitmap = frameWithCards(2000, 1122, 2, {
      menuScale: 0.623,
      barTop: Math.round((0.5 + (0.443 - 0.5) * 0.623) * 1122),
      barRows: 2,
    });
    const scale = aspectScale(2000, 1122);
    expect(
      findRewardCardsInBitmap(bitmap, 2000, 1122, REFERENCE_WARFRAME_UI_SCALE, scale).count,
    ).toBe(2);
  });

  it("finds a reference-scale row when the manual slider is set too low", () => {
    const bitmap = frameWithCards(1920, 1080, 3);
    const found = findRewardCardsInBitmap(bitmap, 1920, 1080, 0.62, REFERENCE_SCALE);
    expect(found.count).toBe(3);
    expect(found.uiScale).toBeGreaterThanOrEqual(0.95);
  });

  it("reports no cards on a blank frame at any scale", () => {
    const bitmap = frameWithCards(2560, 1440, 0);
    expect(
      findRewardCardsInBitmap(bitmap, 2560, 1440, REFERENCE_WARFRAME_UI_SCALE, REFERENCE_SCALE)
        .count,
    ).toBe(0);
  });

  it.each([
    [2560, 1440],
    [3840, 2160],
  ])("does not read a long thin line through the %i x %i bar band as cards", (width, height) => {
    const bitmap = frameWithCards(width, height, 0);
    const lineTop = legacyAt(width, height).barTop;
    for (let y = lineTop; y < lineTop + 3; y++) {
      for (let x = Math.round(0.1 * width); x < Math.round(0.9 * width); x++) {
        bitmap.fill(200, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    }
    expect(
      findRewardCardsInBitmap(bitmap, width, height, REFERENCE_WARFRAME_UI_SCALE, REFERENCE_SCALE)
        .count,
    ).toBe(0);
  });
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

  it("lays out a Legacy-scale screen at the scale its bars were found at", () => {
    const legacy = legacyAt(2560, 1440);
    const image = fakeImage(frameWithCards(2560, 1440, 2, legacy), 2560, 1440);
    const layouts = detectRewardSlotLayoutCandidates(image, REFERENCE_WARFRAME_UI_SCALE);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ count: 2, confidence: 1, counted: true });
    expect(layouts[0].slots[0].x).toBeCloseTo(0.5 + (0.3755 - 0.5) * legacy.menuScale, 2);
    expect(layouts[0].slots[0].width).toBeCloseTo(0.122 * legacy.menuScale, 2);
  });

  it("lays out a 3840x2160 Legacy screen below the slider's 50%", () => {
    const legacy = legacyAt(3840, 2160);
    const image = fakeImage(frameWithCards(3840, 2160, 3, legacy), 3840, 2160);
    const [layout] = detectRewardSlotLayoutCandidates(image, REFERENCE_WARFRAME_UI_SCALE);
    expect(layout).toMatchObject({ count: 3, counted: true });
    expect(layout.slots[0].x).toBeCloseTo(0.5 + (0.312 - 0.5) * legacy.menuScale, 2);
    expect(layout.slots[0].width).toBeCloseTo(0.122 * legacy.menuScale, 2);
  });
});
