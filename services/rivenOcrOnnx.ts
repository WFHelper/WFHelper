"use strict";

/**
 * rivenOcrOnnx.ts
 * ---------------
 * ONNX-based riven text RECOGNIZER for a custom-trained CRNN model.
 * This is the post-training drop-in for the recognition stage only.
 *
 * NOTE: The ONNX model was destroyed during retraining; this module is
 * currently inert (`rivenOcrOnnxAvailable()` returns false).  The riven OCR
 * pipeline now uses the WinRT/Tesseract engine chain from rewardScannerOcr.
 *
 * Model specs:
 *   Input:  float32 [1, 1, 32, W]   grayscale, H=32, W=dynamic, values in [-1,1] (x/127.5-1)
 *   Output: float32 [T, 1, C]       log-softmax CTC character probabilities
 *   Vocab:  70 characters + 1 CTC blank (blank_idx = 70)
 *   Size:   ~2.4 MB ONNX
 *   Speed:  ~4-8 ms CPU / ~0.5 ms GPU per crop
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { withScope } from "./logger";

const log = withScope("rivenOcrOnnx");

// ── Model path resolution ─────────────────────────────────────────────────────

function resolveModelPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "riven_rec.onnx"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "riven_rec.onnx"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "riven_rec.onnx"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveVocabPath(): string {
  const candidates = [
    path.join(
      __dirname,
      "..",
      "scripts",
      "train-paddleocr",
      "output",
      "riven_rec_vocab.json",
    ),
    path.join(
      __dirname,
      "..",
      "..",
      "scripts",
      "train-paddleocr",
      "output",
      "riven_rec_vocab.json",
    ),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "riven_rec_vocab.json"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// ── Lazy session ──────────────────────────────────────────────────────────────

interface VocabData {
  vocab: string[];
  blank_idx: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sessionPromise: Promise<any> | null = null;
let _vocab: string[] = [];
let _blankIdx = 70;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSession(): Promise<any> {
  if (_sessionPromise) return _sessionPromise;

  _sessionPromise = (async () => {
    const modelPath = resolveModelPath();
    const vocabPath = resolveVocabPath();

    if (!existsSync(modelPath)) {
      throw new Error(
        `ONNX model not found at ${modelPath}. ` +
          "Run: python scripts/train-paddleocr/train.py --gpu --epochs 150",
      );
    }

    // onnxruntime-node is an optional peer dep — install when ready to use the ONNX engine.
    // onnxruntime-node is optional — install it once training is complete.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const ort: any = require("onnxruntime-node");

    if (existsSync(vocabPath)) {
      const data = JSON.parse(readFileSync(vocabPath, "utf8")) as VocabData;
      _vocab = data.vocab;
      _blankIdx = data.blank_idx;
    }

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });

    log.log(
      `[RivenOcrOnnx] ONNX model loaded — vocab=${_vocab.length} chars, blank=${_blankIdx}`,
    );
    return session;
  })().catch((err) => {
    _sessionPromise = null; // allow a retry on next call
    throw err;
  });

  return _sessionPromise;
}

/**
 * Returns true if the ONNX model file exists on disk.
 * Does NOT load the model — just checks the file path.
 */
export function rivenOcrOnnxAvailable(): boolean {
  return existsSync(resolveModelPath());
}

// ── Greedy CTC decode ─────────────────────────────────────────────────────────

function greedyCtcDecode(logProbs: Float32Array, T: number, C: number): string {
  const chars: string[] = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bestScore = logProbs[t * C];
    for (let c = 1; c < C; c++) {
      if (logProbs[t * C + c] > bestScore) {
        bestScore = logProbs[t * C + c];
        best = c;
      }
    }
    if (best !== _blankIdx && best !== prev) {
      chars.push(_vocab[best] ?? "");
    }
    prev = best;
  }
  return chars.join("");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Recognize text in a single riven stat line PNG crop.
 *
 * This covers RECOGNITION ONLY.  Feed it one detected text-region crop at a
 * time (the crop that paddleOcrServer would normally pass to the PP-OCRv4 rec
 * model).  Returns the recognized text string.
 *
 * @param pngBuffer  PNG-encoded image of a single text line (any size).
 *                   Will be resized to height=32, keeping aspect ratio.
 */
export async function recognizeRivenCrop(pngBuffer: Buffer): Promise<string> {
  const session = await getSession();

  // Resize to H=32, keep aspect ratio; pad horizontally if too narrow.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");
  const { data, info } = await sharp(pngBuffer)
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const float32 = new Float32Array(W * 32);
  for (let i = 0; i < data.length; i++) {
    float32[i] = (data as Buffer)[i] / 127.5 - 1.0;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const ort: any = require("onnxruntime-node");
  const tensor = new ort.Tensor("float32", float32, [1, 1, 32, W]);
  const output = await session.run({ image: tensor });

  const logProbs: Float32Array = output["log_probs"]?.data ?? output["logits"]?.data;
  const [T, , C]: [number, number, number] = (output["log_probs"]?.dims ?? output["logits"]?.dims) ?? [0, 1, 1];
  return greedyCtcDecode(logProbs, T, C);
}

// ── Per-card recognition pipeline ────────────────────────────────────────────

interface CardStatsBounds { xMin: number; yMin: number; xMax: number; yMax: number }

/**
 * Pure-RGBA port of detectRivenCardFrame + refineRivenTextCrop from
 * rivenScanImage.ts.  Uses the same Sobel edge detection + golden/blue-cyan
 * color-border scoring algorithm on raw RGBA pixel data so it can run entirely
 * within rivenOcrOnnx (no nativeImage required).
 *
 * Returns the stats text sub-area bounds — i.e. the region that
 * refineRivenTextCrop would crop to: frame.top+34% → +84% (height),
 * frame.left+8% → +92% (width).  Returns null when the frame cannot be
 * confidently located (card too small, or no clear edge peaks).
 */
function detectCardStatsBoundsFromRgba(rgba: Buffer, W: number, H: number): CardStatsBounds | null {
  if (W < 160 || H < 120) return null;

  const sampleCols = Math.min(W, 220);
  const sampleRows = Math.min(H, 180);
  const stepX = Math.max(1, Math.floor(W / sampleCols));
  const stepY = Math.max(1, Math.floor(H / sampleRows));

  const luma: number[][] = Array.from({ length: sampleRows }, () =>
    new Array<number>(sampleCols).fill(0),
  );
  const colScore = new Array<number>(sampleCols).fill(0);
  const rowScore = new Array<number>(sampleRows).fill(0);

  for (let sy = 0; sy < sampleRows; sy++) {
    const y = Math.min(H - 1, sy * stepY);
    for (let sx = 0; sx < sampleCols; sx++) {
      const x = Math.min(W - 1, sx * stepX);
      const i = (y * W + x) * 4; // RGBA from Sharp
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      luma[sy][sx] = (r + g + b) / 3;
      const isGolden  = r > 180 && g > 140 && b < 120 && r - b > 80;
      const isBlueCyan = b > 160 && g > 120 && r < 100 && b - r > 80;
      if (isGolden || isBlueCyan) { colScore[sx]++; rowScore[sy]++; }
    }
  }

  const colEdge = new Array<number>(sampleCols).fill(0);
  const rowEdge = new Array<number>(sampleRows).fill(0);
  for (let sy = 1; sy < sampleRows - 1; sy++) {
    for (let sx = 1; sx < sampleCols - 1; sx++) {
      const gx =
        -luma[sy-1][sx-1] + luma[sy-1][sx+1]
        -2*luma[sy][sx-1] + 2*luma[sy][sx+1]
        -luma[sy+1][sx-1] + luma[sy+1][sx+1];
      const gy =
        -luma[sy-1][sx-1] - 2*luma[sy-1][sx] - luma[sy-1][sx+1]
        +luma[sy+1][sx-1] + 2*luma[sy+1][sx] + luma[sy+1][sx+1];
      colEdge[sx] += Math.abs(gx);
      rowEdge[sy] += Math.abs(gy);
    }
  }

  const cc = colEdge.map((e, i) => e + colScore[i] * 12);
  const rr = rowEdge.map((e, i) => e + rowScore[i] * 12);
  const smooth = (a: number[]) =>
    a.map((_, i) => (a[Math.max(0, i-1)] + a[i] + a[Math.min(a.length-1, i+1)]) / 3);
  const sc = smooth(cc);
  const sr = smooth(rr);

  const peak = (arr: number[], lo: number, hi: number) => {
    let best = -1, bestV = 0;
    for (let i = lo; i < hi; i++) if (arr[i] > bestV) { bestV = arr[i]; best = i; }
    return best;
  };

  const lp = peak(sc, Math.floor(sampleCols * 0.05), Math.floor(sampleCols * 0.42));
  const rp = peak(sc, Math.floor(sampleCols * 0.45), Math.floor(sampleCols * 0.94));
  const tp = peak(sr, Math.floor(sampleRows * 0.02), Math.floor(sampleRows * 0.30));
  const bp = peak(sr, Math.floor(sampleRows * 0.60), Math.floor(sampleRows * 0.98));

  if (lp < 0 || rp < 0 || tp < 0 || bp < 0 || rp <= lp) return null;

  const fL = lp * stepX, fT = tp * stepY;
  const fW = (rp - lp) * stepX, fH = (bp - tp) * stepY;
  // Require the frame to span a meaningful fraction of the input image.
  // For SINGLE_CARD_CROP the card is ≈30-50% of image width; for ROLL_CARD_CROP ≈70-95%.
  if (fW < W * 0.20 || fH < H * 0.30) return null;

  // Apply refineRivenTextCrop bounds: left+8%, top+34%, width×84%, height×50%
  return {
    xMin: Math.max(0, Math.floor(fL + fW * 0.08)),
    xMax: Math.min(W, Math.ceil(fL + fW * 0.08 + fW * 0.84)),
    yMin: Math.max(0, Math.floor(fT + fH * 0.34)),
    yMax: Math.min(H, Math.ceil(fT + fH * 0.34 + fH * 0.50)),
  };
}

/**
 * Detect individual text-line Y positions within a PNG card crop using a
 * per-row luminance standard-deviation profile restricted to a specific
 * x-column and y-range.
 *
 * Uses variance instead of brightness density so animated Kuva portal
 * backgrounds (sparse bright sparks → low SD ~10-20) don't trigger false
 * positives.  Text rows with characters on dark backgrounds have SD ~40-90.
 *
 * Returns row bounds in the input PNG's coordinate space.
 */
async function detectStatRows(
  cardPng: Buffer,
  colStartFrac: number,
  colEndFrac: number,
  yStartPx = 0,
  yEndPx?: number,
): Promise<Array<{ y: number; height: number }>> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");
  const { data: rawData, info } = await sharp(cardPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const H: number = info.height;
  const W: number = info.width;
  const yStart = Math.max(0, yStartPx);
  const yEnd   = Math.min(H, yEndPx ?? H);
  const regionH = Math.max(1, yEnd - yStart);

  const xStart = Math.max(0, Math.floor(W * colStartFrac));
  const xEnd   = Math.min(W, Math.ceil(W * colEndFrac));
  const colW   = Math.max(1, xEnd - xStart);

  const targetH = 800;
  const scale = targetH / regionH;
  const scaledColW = Math.max(1, Math.round(colW * scale));

  const colBuf: Buffer = await sharp(rawData, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: xStart, top: yStart, width: colW, height: regionH })
    .resize(scaledColW, targetH, { kernel: "linear" })
    .raw()
    .toBuffer();

  // Per-row luminance standard deviation.
  const SD_THRESH = 20;
  const rowSD = new Float32Array(targetH);
  for (let y = 0; y < targetH; y++) {
    let sum = 0;
    for (let x = 0; x < scaledColW; x++) {
      const i = (y * scaledColW + x) * 4;
      sum += 0.299 * (colBuf as Buffer)[i] + 0.587 * (colBuf as Buffer)[i + 1] + 0.114 * (colBuf as Buffer)[i + 2];
    }
    const mean = sum / scaledColW;
    let sqDiff = 0;
    for (let x = 0; x < scaledColW; x++) {
      const i = (y * scaledColW + x) * 4;
      const luma = 0.299 * (colBuf as Buffer)[i] + 0.587 * (colBuf as Buffer)[i + 1] + 0.114 * (colBuf as Buffer)[i + 2];
      const d = luma - mean;
      sqDiff += d * d;
    }
    rowSD[y] = Math.sqrt(sqDiff / scaledColW);
  }

  const gapTol   = Math.max(3, Math.floor(targetH * 0.015));
  const minLineH = Math.max(4, Math.floor(targetH * 0.015));
  const maxLineH = Math.floor(targetH * 0.30);
  const expandPx = Math.max(2, Math.floor(targetH * 0.010));

  const lines: Array<{ y: number; height: number }> = [];
  let lineStart = -1;
  let lastBright = -1;

  for (let y = 0; y <= targetH; y++) {
    const bright = y < targetH && rowSD[y] >= SD_THRESH;
    if (bright) {
      if (lineStart < 0) lineStart = y;
      lastBright = y;
    } else if (lineStart >= 0 && (y - lastBright > gapTol || y >= targetH)) {
      const h = lastBright - lineStart + 1;
      if (h >= minLineH && h <= maxLineH) {
        const origTop = Math.max(0, yStart + Math.round((lineStart - expandPx) / scale));
        const origBot = Math.min(H, yStart + Math.round((lastBright + 1 + expandPx) / scale));
        lines.push({ y: origTop, height: origBot - origTop });
      }
      lineStart = -1;
      lastBright = -1;
    }
  }
  return lines;
}

/**
 * Detect stat rows in a riven card PNG and recognize each with the CRNN model.
 *
 * Replaces the Python PaddleOCR detect+recognize path: variance-based row
 * profiling finds exact line Y positions, CRNN handles riven-specific vocab.
 *
 * For multipanel (ROLL_CARD_CROP) images the variance detector reliably finds
 * rows on the clean narrow crop.  For single-card crops the card art and Kuva
 * animation background raise ~30% of all pixels above any reasonable SD threshold,
 * collapsing the entire region into one oversized block that exceeds maxLineH and
 * returns zero rows.  When variance detection yields <2 rows the fallback uses
 * large strips (≈⅓ of the stats area per strip) in three staggered passes so
 * that every stat line ≥50 px tall falls entirely within at least one strip —
 * eliminating the digit fragmentation caused by the old 22 px overlapping grid.
 *
 * @param cardPng      PNG buffer of the riven card region (any size).
 * @param isMultipanel true for the narrow ROLL_CARD_CROP (multipanel diorama).
 * @param statsOnlyMode true when the input has already been refined to just the
 *                     stats text area (e.g. via refineRivenTextCrop in production).
 *                     Widens the Y search range and column bounds so variance
 *                     detection covers the full image height.
 * @returns            Recognized text lines top-to-bottom.
 *                     Join with "\n" and pass to parseRivenStats().
 */
export async function recognizeRivenCardLines(
  cardPng: Buffer,
  isMultipanel = false,
  statsOnlyMode = false,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");

  const { data: rawData, info } = await sharp(cardPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W: number = info.width;
  const H: number = info.height;

  // ── Single-card without pre-refinement: return sparse so WinRT handles it ──
  // The SINGLE_CARD_CROP (1075×486) contains card art + animated Kuva portal.
  // Reliable CRNN output requires the stats-only sub-image produced by
  // refineRivenTextCrop in production.  When the caller hasn't pre-refined
  // (statsOnlyMode=false, !isMultipanel), return [] immediately so
  // ocrCropMultiStrategy falls through to WinRT (100% accurate on this crop).
  if (!isMultipanel && !statsOnlyMode) {
    return [];
  }

  // Column bounds:
  //   statsOnlyMode  — full image IS the stats area; 3-97% covers all text.
  //   isMultipanel   — narrow ROLL_CARD_CROP; 12-90% reliable range.
  const colStartFrac = statsOnlyMode ? 0.03 : 0.12;
  const colEndFrac   = statsOnlyMode ? 0.97 : 0.90;
  const colLeft  = Math.max(0, Math.floor(W * colStartFrac));
  const colRight = Math.min(W, Math.ceil(W * colEndFrac));
  const colW = colRight - colLeft;

  // Stats area Y range.  statsOnlyMode: full image height (stats span 3-97%).
  // Multipanel: 40-82% (the stats panel occupies the lower half of the crop).
  const yMin = statsOnlyMode ? Math.floor(H * 0.03) : Math.floor(H * 0.40);
  const yMax = statsOnlyMode ? Math.min(H, Math.ceil(H * 0.97)) : Math.min(H, Math.ceil(H * 0.82));

  // ── Step 1: Variance-based row detection on raw card image ─────────────────
  let rows = await detectStatRows(cardPng, colStartFrac, colEndFrac, yMin, yMax);

  // ── Step 2: Grid fallback when variance detection finds <2 rows ─────────────
  // Single-card crops include card art + Kuva animation: ~30% of pixels exceed
  // any reasonable brightness threshold, making every row appear "bright" to the
  // SD detector.  Multi-panel crops almost always yield ≥2 rows via variance
  // detection, so this code effectively runs for single cards only.
  //
  // Riven stat text lines are ≈22–25 px tall at H=486.  The old lineH of 22 px
  // (H*0.045) was too small — it could not fully contain a text line, so the
  // leading digit of values like "+126.2%" was regularly clipped.
  //
  // New lineH = 29 px (H*0.060): the strip is ~6-7 px taller than the text line,
  // giving a guaranteed-full-capture margin.  With 3 passes at lineH/3 ≈ 10 px
  // offsets, the max misalignment is 5 px < 6 px margin — so every stat line is
  // fully contained in at least one strip, including all leading digits.
  if (rows.length < 2) {
    const lineH = Math.max(26, Math.round(H * 0.060));
    const off1  = Math.round(lineH / 3);
    const gridRows: Array<{ y: number; height: number }> = [];
    for (const off of [0, off1, 2 * off1]) {
      for (let y = yMin + off; y < yMax; y += lineH) {
        const h = Math.min(lineH, yMax - y);
        if (h >= 20) gridRows.push({ y, height: h });
      }
    }
    rows = gridRows.sort((a, b) => a.y - b.y);
  }

  // ── Step 3: Crop each row at the text column and run CRNN ──
  // Always recognize from the ORIGINAL (colour) card for best CRNN accuracy.
  const lines: string[] = [];
  for (const row of rows) {
    const rowH = Math.max(1, row.height);
    if (row.y < 0 || row.y + rowH > H || colW < 1) continue;
    const strip: Buffer = await (sharp as typeof import("sharp"))(
      rawData as Buffer,
      { raw: { width: W, height: H, channels: 4 } },
    )
      .extract({ left: colLeft, top: row.y, width: colW, height: rowH })
      .png()
      .toBuffer();
    const text = (await recognizeRivenCrop(strip)).trim();
    if (text) lines.push(text);
  }
  return lines;
}
