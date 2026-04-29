import os from "os";
import path from "path";

export type RewardBand = { top: number; height: number };

export const SCANNER_TUNING = Object.freeze({
  paths: Object.freeze({
    ocrScript: path.join(__dirname, "..", "scripts", "ocr.ps1"),
    tempImage: path.join(os.tmpdir(), "wf-companion-reward-ocr.png"),
  }),
  budget: Object.freeze({
    // Enough for one structured-OCR pass on slower machines.
    minMs: 1800,
    // Keeps the overlay responsive instead of waiting on diminishing OCR passes.
    maxMs: 5000,
  }),
  temporal: Object.freeze({
    // Reward screens are short-lived; 12s spans one screen without bleeding far into the next run.
    windowMs: 12_000,
    maxResults: 5,
  }),
  lowInfoCrop: Object.freeze({
    // Sample roughly a 40x40 grid and skip crops whose luminance barely changes.
    sampleGrid: 40,
    minLuminanceRange: 18,
  }),
  strategy: Object.freeze({
    historyMax: 10,
  }),
  slot: Object.freeze({
    minLayoutConfidence: 0.38,
    partialAcceptFillRatio: 0.75,
    partialAcceptElapsedRatio: 0.7,
  }),
  ocr: Object.freeze({
    textPreviewMaxChars: 240,
  }),
});

export const RELIC_ERA_BANDS: ReadonlyArray<RewardBand> = Object.freeze([
  { top: 0.12, height: 0.12 },
  { top: 0.16, height: 0.13 },
  { top: 0.2, height: 0.14 },
]);

export const RELIC_ROW_TILE_LABEL_RECTS: ReadonlyArray<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> = Object.freeze([
  { id: "slot-1", x: 0.02, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-2", x: 0.2, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-3", x: 0.38, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-4", x: 0.56, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-5", x: 0.74, y: 0.5, width: 0.18, height: 0.42 },
]);

export const CROP_PRESETS: Readonly<Record<string, ReadonlyArray<RewardBand>>> = Object.freeze({
  balanced: Object.freeze([
    { top: 0.38, height: 0.36 },
    { top: 0.36, height: 0.4 },
    { top: 0.4, height: 0.34 },
  ]),
});
