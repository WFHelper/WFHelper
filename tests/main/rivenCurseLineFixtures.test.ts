import { describe, expect, it } from "vitest";
import { join } from "node:path";
import sharp from "sharp";
import { recognizeStatArea, rivenOcrOnnxAvailable } from "../../services/rivenOcrOnnx";
import { parseRivenStats } from "../../ipc/overlay/rivenScanText";
import { statCropUpscaleFactor } from "../../ipc/overlay/rivenScanImage";

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
