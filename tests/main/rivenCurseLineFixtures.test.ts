import type { NativeImage } from "electron";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import sharp from "sharp";
import {
  hasLowConfidenceLine,
  recognizeStatArea,
  rivenOcrOnnxAvailable,
} from "../../services/rivenOcrOnnx";
import { parseRivenStats } from "../../ipc/overlay/rivenScanText";
import {
  cropRivenStatImage,
  RIVEN_SCAN_CROPS,
  statCropUpscaleFactor,
} from "../../ipc/overlay/rivenScanImage";
import { fakeImage } from "./frameCanvas";

// Both crops are the same Angstrum riven at 224x162, saved from a 1278x768 game
// window. The chat-linked one lost "-90.9% Projectile Speed" at native scale and
// kept every other line.
const FIXTURES = join(__dirname, "..", "fixtures", "riven");
const EXPECTED = ["+159 Multishot", "+276.2 Damage", "+93.2 Fire Rate", "-90.9 Projectile Speed"];

async function readStats(file: string, scale: number): Promise<string[]> {
  const path = join(FIXTURES, file);
  const meta = await sharp(path).metadata();
  const { data, info } = await sharp(path)
    .resize((meta.width ?? 0) * scale, (meta.height ?? 0) * scale, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = await recognizeStatArea(data, info.width, info.height);
  return parseRivenStats(result.text).map(
    (stat) => `${stat.positive ? "+" : "-"}${stat.value} ${stat.name}`,
  );
}

describe.runIf(rivenOcrOnnxAvailable())("riven curse line on saved crops", () => {
  it("scales a 162px band up rather than reading it at native size", () => {
    expect(statCropUpscaleFactor(162)).toBe(2);
    expect(statCropUpscaleFactor(228)).toBe(2);
    expect(statCropUpscaleFactor(400)).toBe(1);
  });

  it("keeps the curse line on a chat-linked card at the chosen scale", async () => {
    expect(await readStats("chat-card-angstrum-stats.png", statCropUpscaleFactor(162))).toEqual(
      EXPECTED,
    );
  }, 120000);

  it("still reads the mod-screen card of the same riven", async () => {
    expect(await readStats("mod-card-angstrum-stats.png", statCropUpscaleFactor(162))).toEqual(
      EXPECTED,
    );
  }, 120000);

  it("shows the chat-linked card is the one that needs the scale", async () => {
    expect(await readStats("chat-card-angstrum-stats.png", 1)).not.toContain(
      "-90.9 Projectile Speed",
    );
    expect(await readStats("mod-card-angstrum-stats.png", 1)).toEqual(EXPECTED);
  }, 120000);
});

// Production stat crops from 1920x1080 Update 44 cycle screens, Critical Chance
// trait-locked: grey text between two padlocks, wrapped onto a second line.
describe.runIf(rivenOcrOnnxAvailable())("trait-locked stat on saved crops", () => {
  it("reads the locked stat on the mod-screen card", async () => {
    expect(
      await readStats("mod-card-soma-trait-locked-stats.png", statCropUpscaleFactor(243)),
    ).toEqual(["+1.5 Damage to Grineer", "+167.2 Critical Chance"]);
  }, 120000);

  it("reads the locked stat on the dimmed choice card", async () => {
    expect(
      await readStats("choice-card-soma-trait-locked-stats.png", statCropUpscaleFactor(234)),
    ).toEqual(["+133.7 Puncture", "+167.2 Critical Chance"]);
  }, 120000);
});

/** Game frame with a saved rough roll-card crop put back where the crop came from. */
async function rollFrame(file: string, frameW: number, frameH: number): Promise<NativeImage> {
  const { data, info } = await sharp(join(FIXTURES, file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const frame = Buffer.alloc(frameW * frameH * 4);
  const left = Math.floor(frameW * RIVEN_SCAN_CROPS.rollCard.x);
  const top = Math.floor(frameH * RIVEN_SCAN_CROPS.rollCard.y);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const src = (y * info.width + x) * 4;
      const dst = ((top + y) * frameW + left + x) * 4;
      frame[dst] = data[src + 2];
      frame[dst + 1] = data[src + 1];
      frame[dst + 2] = data[src];
      frame[dst + 3] = 255;
    }
  }
  return fakeImage(frameW, frameH, frame);
}

async function readRollCard(file: string, frameW: number, frameH: number) {
  const { statCrop } = cropRivenStatImage(
    await rollFrame(file, frameW, frameH),
    RIVEN_SCAN_CROPS.rollCard,
    "window",
  );
  const { width, height } = statCrop.getSize();
  const bgra = statCrop.toBitmap();
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = 255;
  }
  const scale = statCropUpscaleFactor(height);
  const { data, info } = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(width * scale, height * scale, { kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = await recognizeStatArea(data, info.width, info.height);
  const stats = parseRivenStats(result.text).map(
    (stat) => `${(stat.displayPositive ?? stat.positive) ? "+" : "-"}${stat.value} ${stat.name}`,
  );
  return { lines: result.lines.map((line) => line.text), stats };
}

// Rough roll crops saved at 1920x1080 (Corufell, owner's screenshot of the new
// roll) and in a 1811x1019 window (Boar). The band used to sample only the left
// 320 columns of the crop for text bounds and clipped every line on the right.
describe.runIf(rivenOcrOnnxAvailable())("roll card crops", () => {
  it("keeps the trait-locked line of a wrapped new-roll card", async () => {
    const { stats } = await readRollCard("roll-card-corufell-trait-locked.png", 1920, 1080);
    expect(stats).toEqual([
      "+110.1 Finisher Damage",
      "+88.1 Heat",
      "+166.4 Critical Chance",
      "-101.5 Puncture",
    ]);
  }, 120000);

  it("reads every line to its right edge", async () => {
    const { lines } = await readRollCard("roll-card-boar-argi.png", 1811, 1019);
    expect(lines).toContain("Boar Argi-visitak");
    expect(lines).toContain("x1,49 Damage to Grineer");
    expect(lines).toContain("+49,2% Reload Speed");
  }, 120000);
});

describe.runIf(rivenOcrOnnxAvailable())("element icon line confidence", () => {
  // The fire icon drags "+86,5% Heat" to 0.799 once the padding's edge spaces count.
  it("passes a chat card whose Heat line carries the icon", async () => {
    const path = join(FIXTURES, "chat-card-arum-heat-icon-stats.png");
    const meta = await sharp(path).metadata();
    const scale = statCropUpscaleFactor(meta.height ?? 0);
    const { data, info } = await sharp(path)
      .resize((meta.width ?? 0) * scale, (meta.height ?? 0) * scale, { kernel: "lanczos3" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await recognizeStatArea(data, info.width, info.height);
    expect(hasLowConfidenceLine(result)).toBe(false);
    expect(parseRivenStats(result.text).map((s) => `${s.value} ${s.name}`)).toEqual([
      "86.5 Heat",
      "86.3 Critical Damage",
      "140.9 Melee Damage",
    ]);
  }, 120000);
});
