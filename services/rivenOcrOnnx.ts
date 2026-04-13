/**
 * rivenOcrOnnx.ts
 * ---------------
 * YOLO + PaddleOCR CH v3 pipeline for riven stat OCR.
 *
 * Pipeline:
 *   1. YOLO stat-line detector (stat_line_detector.onnx) — detects bounding boxes
 *      around individual stat text lines in the riven card stat area.
 *   2. Crop extraction — extracts padded crops from detected boxes, filters by
 *      height (removes title/footer false positives), upscales uniformly.
 *   3. PaddleOCR CH v3 recognizer (ch_PP-OCRv3_rec_infer.onnx) — batch CTC text
 *      recognition with per-character confidence scores.
 *   4. Postprocessing — deterministic regex corrections for known misreads.
 *   5. Split-line merging — merges multi-word stat names split across YOLO boxes.
 *
 * Model files:
 *   - scripts/train-paddleocr/output/yolo_detector/stat_line_detector.onnx  (11.7 MB)
 *   - scripts/train-paddleocr/output/paddle_ocr/ch_PP-OCRv3_rec_infer.onnx (10.2 MB)
 *   - scripts/train-paddleocr/models/ch_dict.txt                           (32 KB)
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { withScope } from "./logger";

const log = withScope("rivenOcrOnnx");

// ── Model path resolution ─────────────────────────────────────────────────────

function resolveYoloModelPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "yolo_detector", "stat_line_detector.onnx"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "yolo_detector", "stat_line_detector.onnx"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "yolo_detector", "stat_line_detector.onnx"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveChRecModelPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "paddle_ocr", "ch_PP-OCRv3_rec_infer.onnx"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "paddle_ocr", "ch_PP-OCRv3_rec_infer.onnx"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "paddle_ocr", "ch_PP-OCRv3_rec_infer.onnx"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveChDictPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "models", "ch_dict.txt"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "models", "ch_dict.txt"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "models", "ch_dict.txt"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// ── ONNX session type (lazy-loaded via require, cannot import directly) ──────

/** Minimal interface matching onnxruntime-node InferenceSession */
interface OrtInferenceSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}

// ── Lazy ONNX sessions ───────────────────────────────────────────────────────

let _yoloSessionPromise: Promise<OrtInferenceSession> | null = null;
let _yoloInputName = "";
let _yoloInputSize = 640;

let _chRecSessionPromise: Promise<OrtInferenceSession> | null = null;
let _chDict: string[] = [];

async function getYoloSession(): Promise<OrtInferenceSession> {
  if (_yoloSessionPromise) return _yoloSessionPromise;

  _yoloSessionPromise = (async () => {
    const modelPath = resolveYoloModelPath();
    if (!existsSync(modelPath)) {
      throw new Error(`YOLO model not found at ${modelPath}`);
    }

  
    const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      interOpNumThreads: 2,
      intraOpNumThreads: 4,
    });

    _yoloInputName = session.inputNames[0];

    log.log(`[RivenOcrOnnx] YOLO detector loaded — input=${_yoloInputName} size=${_yoloInputSize}`);
    return session as unknown as OrtInferenceSession;
  })().catch((err) => {
    _yoloSessionPromise = null;
    throw err;
  });

  const pending = _yoloSessionPromise;
  return pending;
}

async function getChRecSession(): Promise<OrtInferenceSession> {
  if (_chRecSessionPromise) return _chRecSessionPromise;

  _chRecSessionPromise = (async () => {
    const modelPath = resolveChRecModelPath();
    const dictPath = resolveChDictPath();
    if (!existsSync(modelPath)) {
      throw new Error(`PaddleOCR CH model not found at ${modelPath}`);
    }

    const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

    // Load dictionary: index 0 = blank (CTC), then one char per line
    if (existsSync(dictPath)) {
      const dictContent = readFileSync(dictPath, "utf8");
      _chDict = ["blank", ...dictContent.split("\n").filter((l) => l.length > 0)];
    }

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      interOpNumThreads: 2,
      intraOpNumThreads: 4,
    });

    log.log(`[RivenOcrOnnx] PaddleOCR CH v3 loaded — ${_chDict.length} chars (incl. blank)`);
    return session as unknown as OrtInferenceSession;
  })().catch((err) => {
    _chRecSessionPromise = null;
    throw err;
  });

  const pending = _chRecSessionPromise;
  return pending;
}

/**
 * Returns true if both YOLO and PaddleOCR CH model files exist on disk.
 * Does NOT load the models — just checks file paths.
 */
export function rivenOcrOnnxAvailable(): boolean {
  return existsSync(resolveYoloModelPath()) && existsSync(resolveChRecModelPath());
}

// ── YOLO stat-line detection ──────────────────────────────────────────────────

interface YoloBox {
  y1: number;
  y2: number;
  x1: number;
  x2: number;
  confidence: number;
}

/**
 * Run YOLO detector on a stat area image and return bounding boxes sorted by Y.
 *
 * @param rgbaBuf Raw RGBA buffer from Sharp
 * @param W       Image width
 * @param H       Image height
 * @param confThresh Minimum detection confidence (default 0.25)
 * @param iouThresh  NMS IoU threshold (default 0.5)
 */
async function yoloDetectStatLines(
  rgbaBuf: Buffer,
  W: number,
  H: number,
  confThresh = 0.25,
  iouThresh = 0.5,
): Promise<YoloBox[]> {
  const session = await getYoloSession();


  const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

  const sharp: typeof import("sharp") = require("sharp");

  const imgsz = _yoloInputSize; // 640

  // Letterbox resize: scale to fit 640×640, center-pad with 114
  const scale = Math.min(imgsz / H, imgsz / W);
  const newW = Math.round(W * scale);
  const newH = Math.round(H * scale);
  const padLeft = Math.floor((imgsz - newW) / 2);
  const padTop = Math.floor((imgsz - newH) / 2);

  // Resize RGBA to newW×newH, then extract RGB channels
  const resizedBuf: Buffer = await sharp(rgbaBuf, { raw: { width: W, height: H, channels: 4 } })
    .resize(newW, newH, { kernel: "linear" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Build padded 640×640 blob in CHW format, RGB, normalized 0-1
  const blobSize = 3 * imgsz * imgsz;
  const blob = new Float32Array(blobSize);
  const fillVal = 114 / 255;
  blob.fill(fillVal);

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = (y * newW + x) * 3;
      const dstY = y + padTop;
      const dstX = x + padLeft;
      blob[0 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx] / 255;     // R
      blob[1 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx + 1] / 255; // G
      blob[2 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx + 2] / 255; // B
    }
  }

  const tensor = new ort.Tensor("float32", blob, [1, 3, imgsz, imgsz]);
  const output = await session.run({ [_yoloInputName]: tensor });

  const outputName = session.outputNames[0];
  const preds: Float32Array = output[outputName].data;
  const predDims: number[] = output[outputName].dims;

  const boxes: Array<{ conf: number; y1: number; y2: number; x1: number; x2: number }> = [];

  if (predDims.length === 3) {
    // Shape [1, 5, N] — transposed format
    const numBoxes = predDims[2];

    for (let i = 0; i < numBoxes; i++) {
      const conf = preds[4 * numBoxes + i];
      if (conf < confThresh) continue;

      const cx = preds[0 * numBoxes + i];
      const cy = preds[1 * numBoxes + i];
      const bw = preds[2 * numBoxes + i];
      const bh = preds[3 * numBoxes + i];

      let x1 = (cx - bw / 2 - padLeft) / scale;
      let y1 = (cy - bh / 2 - padTop) / scale;
      let x2 = (cx + bw / 2 - padLeft) / scale;
      let y2 = (cy + bh / 2 - padTop) / scale;

      x1 = Math.max(0, Math.min(W, x1));
      y1 = Math.max(0, Math.min(H, y1));
      x2 = Math.max(0, Math.min(W, x2));
      y2 = Math.max(0, Math.min(H, y2));

      if (x2 - x1 < 10 || y2 - y1 < 3) continue;

      boxes.push({
        conf,
        y1: Math.round(y1),
        y2: Math.round(y2),
        x1: Math.round(x1),
        x2: Math.round(x2),
      });
    }
  }

  // Greedy NMS
  boxes.sort((a, b) => b.conf - a.conf);
  const keep: typeof boxes = [];
  for (const box of boxes) {
    let suppressed = false;
    for (const kept of keep) {
      const ix1 = Math.max(box.x1, kept.x1);
      const iy1 = Math.max(box.y1, kept.y1);
      const ix2 = Math.min(box.x2, kept.x2);
      const iy2 = Math.min(box.y2, kept.y2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaB = (box.x2 - box.x1) * (box.y2 - box.y1);
      const areaK = (kept.x2 - kept.x1) * (kept.y2 - kept.y1);
      const union = areaB + areaK - inter;
      if (union > 0 && inter / union > iouThresh) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) keep.push(box);
  }

  keep.sort((a, b) => a.y1 - b.y1);

  return keep.map((b) => ({
    y1: b.y1,
    y2: b.y2,
    x1: b.x1,
    x2: b.x2,
    confidence: b.conf,
  }));
}

// ── Crop extraction + upscaling ───────────────────────────────────────────────

const MAX_STAT_CROP_HEIGHT = 80;
const MIN_OCR_WIDTH = 1200;

interface RgbCrop {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Extract RGB crops from YOLO boxes with padding, filter by height, and
 * upscale uniformly so the widest crop is at least MIN_OCR_WIDTH.
 */
async function extractAndUpscaleCrops(
  rgbaBuf: Buffer,
  W: number,
  H: number,
  boxes: YoloBox[],
  padY = 8,
  padX = 8,
): Promise<RgbCrop[]> {
  if (boxes.length === 0) return [];


  const sharp: typeof import("sharp") = require("sharp");

  const rawCrops: RgbCrop[] = [];
  for (const box of boxes) {
    const cy1 = Math.max(0, box.y1 - padY);
    const cy2 = Math.min(H, box.y2 + padY);
    const cx1 = Math.max(0, box.x1 - padX);
    const cx2 = Math.min(W, box.x2 + padX);
    const cw = cx2 - cx1;
    const ch = cy2 - cy1;

    if (cw < 20 || ch < 5 || ch > MAX_STAT_CROP_HEIGHT) continue;

    const cropBuf: Buffer = await sharp(rgbaBuf, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: cx1, top: cy1, width: cw, height: ch })
      .removeAlpha()
      .raw()
      .toBuffer();

    rawCrops.push({ data: cropBuf, width: cw, height: ch });
  }

  if (rawCrops.length === 0) return [];

  // Uniform integer upscale
  const maxW = Math.max(...rawCrops.map((c) => c.width));
  if (maxW >= MIN_OCR_WIDTH) return rawCrops;

  const scaleFactor = Math.ceil(MIN_OCR_WIDTH / maxW);
  const upscaled: RgbCrop[] = [];
  for (const crop of rawCrops) {
    const newW = Math.min(6000, crop.width * scaleFactor);
    const newH = Math.min(6000, crop.height * scaleFactor);
    const resized: Buffer = await sharp(crop.data, {
      raw: { width: crop.width, height: crop.height, channels: 3 },
    })
      .resize(newW, newH, { kernel: "linear" })
      .raw()
      .toBuffer();
    upscaled.push({ data: resized, width: newW, height: newH });
  }

  return upscaled;
}

// ── PaddleOCR CH v3 recognition ───────────────────────────────────────────────

/** Per-line OCR result with confidence score. */
export interface OcrLineResult {
  text: string;
  confidence: number;
}

/**
 * CTC greedy decode: argmax per timestep, remove blanks and duplicates.
 * Returns decoded text and mean confidence (from softmax probabilities).
 */
function ctcGreedyDecode(
  preds: Float32Array,
  seqLen: number,
  numClasses: number,
  batchIdx: number,
): OcrLineResult {
  const offset = batchIdx * seqLen * numClasses;
  const textParts: string[] = [];
  const confParts: number[] = [];
  let prev = 0; // blank index = 0

  for (let t = 0; t < seqLen; t++) {
    const base = offset + t * numClasses;

    let bestIdx = 0;
    let bestVal = preds[base];
    for (let c = 1; c < numClasses; c++) {
      if (preds[base + c] > bestVal) {
        bestVal = preds[base + c];
        bestIdx = c;
      }
    }

    if (bestIdx !== 0 && bestIdx !== prev) {
      if (bestIdx < _chDict.length) {
        textParts.push(_chDict[bestIdx]);
        confParts.push(bestVal);
      }
    }
    prev = bestIdx;
  }

  const text = textParts.join("");
  const confidence = confParts.length > 0
    ? confParts.reduce((a, b) => a + b, 0) / confParts.length
    : 0;

  return { text, confidence };
}

/**
 * Batch-recognize all crops using PaddleOCR CH v3.
 * Preprocessing: resize to h=48, preserve aspect, normalize [-1,1], zero-pad.
 */
async function recognizeCropsBatch(crops: RgbCrop[]): Promise<OcrLineResult[]> {
  if (crops.length === 0) return [];
  const session = await getChRecSession();


  const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

  const sharp: typeof import("sharp") = require("sharp");

  const imgH = 48;

  // Compute max width/height ratio for uniform padding width
  const whRatios = crops.map((c) => c.width / c.height);
  const maxWhRatio = Math.max(...whRatios);
  const imgW = Math.ceil(imgH * maxWhRatio);

  // Build batch tensor: [N, 3, 48, imgW], zero-padded
  const batchSize = crops.length;
  const batchData = new Float32Array(batchSize * 3 * imgH * imgW);
  // Float32Array is zero-initialized (0.0 padding, matching Python np.zeros)

  for (let i = 0; i < crops.length; i++) {
    const crop = crops[i];
    const resizedW = Math.min(imgW, Math.ceil(imgH * (crop.width / crop.height)));

    const resizedBuf: Buffer = await sharp(crop.data, {
      raw: { width: crop.width, height: crop.height, channels: 3 },
    })
      .resize(resizedW, imgH, { kernel: "linear" })
      .raw()
      .toBuffer();

    // Write into batch in CHW format, RGB, normalized to [-1, 1]
    const batchOffset = i * 3 * imgH * imgW;
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < resizedW; x++) {
        const srcIdx = (y * resizedW + x) * 3;
        batchData[batchOffset + 0 * imgH * imgW + y * imgW + x] = resizedBuf[srcIdx] / 127.5 - 1.0;
        batchData[batchOffset + 1 * imgH * imgW + y * imgW + x] = resizedBuf[srcIdx + 1] / 127.5 - 1.0;
        batchData[batchOffset + 2 * imgH * imgW + y * imgW + x] = resizedBuf[srcIdx + 2] / 127.5 - 1.0;
      }
    }
  }

  const tensor = new ort.Tensor("float32", batchData, [batchSize, 3, imgH, imgW]);
  const inputName = session.inputNames[0];
  const output = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const preds: Float32Array = output[outputName].data;
  const dims: number[] = output[outputName].dims;

  // dims: [batch, seq_len, num_classes]
  const seqLen = dims[1];
  const numClasses = dims[2];

  const results: OcrLineResult[] = [];
  for (let b = 0; b < batchSize; b++) {
    results.push(ctcGreedyDecode(preds, seqLen, numClasses, b));
  }

  return results;
}

// ── Postprocessing ────────────────────────────────────────────────────────────

/**
 * Deterministic corrections for known PaddleOCR CH misreads.
 * Ported 1:1 from benchmark_yolo_ocr.py postprocess_ocr_text().
 */
function postprocessOcrText(text: string): string {
  // Strip asterisk-minus artifact: "*-74,2%" → "-74,2%"
  text = text.replace(/\*-/g, "-");
  // Strip > before uppercase: ">Impact" → "Impact"
  text = text.replace(/>([A-Z])/g, "$1");

  // Insert spaces before CamelCase boundaries
  text = text.replace(/%([A-Z])/g, (m) => m[0] + " " + m[1]);
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2");

  // Word join fixes
  text = text.replace(/Damageto/g, "Damage to");
  text = text.replace(/\bfor([A-Z])/g, "for $1");
  text = text.replace(/(\d)for\b/g, "$1 for");

  // Recover dropped 'x' prefix on multiplier lines
  text = text.replace(/(?:^|\n)(\*?)[A-Za-z]?(\d[,.]?\d*)\s*Damage\s+to\b/gm,
    (_, _star, num) => `x${num} Damage to`);

  // Common letter misreads
  text = text.replace(/Mmpact/g, "Impact");
  text = text.replace(/%\s*mpact/g, "% Impact");

  // Sign + 'i' + digits → sign + '1' + digits: "+i29,1%" → "+129,1%"
  text = text.replace(/([+-])i(\d)/g, "$11$2");

  // x-multiplier: xi/xl → x1
  text = text.replace(/\bx[il]([,.])/g, "x1$1");

  // Double-1: digit + i before separator
  text = text.replace(/(\d)i([,.])/g, "$11$2");

  // Spurious dots: "197.,9%" → "197,9%"
  text = text.replace(/(\d)\.,(\d)/g, "$1,$2");
  text = text.replace(/(\d)\.\.(\d)/g, "$1.$2");

  // Space between digits: "+1 56,2%" → "+156,2%"
  text = text.replace(/(\d) (\d)/g, "$1$2");

  // OCR misspelling
  text = text.replace(/\bAditional\b/g, "Additional");

  return text;
}

// ── Split-line merging ────────────────────────────────────────────────────────

const SPLIT_STAT_TAILS: Record<string, string> = {
  "slide attack":           "Critical Chance for Slide Attack",
  "for slide attack":       "Critical Chance for Slide Attack",
  "for slide":              "Critical Chance for Slide Attack",
  "count chance":           "Additional Combo Count Chance",
  "combo count chance":     "Additional Combo Count Chance",
  "combo count":            "Chance to Gain Combo Count",
  "gain combo count":       "Chance to Gain Combo Count",
  "damage":                 "Finisher Damage",
  "efficiency":             "Heavy Attack Efficiency",
  "attack efficiency":      "Heavy Attack Efficiency",
  "capacity":               "Magazine Capacity",
  "heavy attacks":          "Critical Chance",
  "for heavy attacks":      "Critical Chance",
  "x2 for heavy attacks":   "Critical Chance",
  "for bows":               "Fire Rate",
  "x2 for bows":            "Fire Rate",
  "duration":               "Status Duration",
  "speed":                  "Reload Speed",
  "maximum":                "Ammo Maximum",
  "recoil":                 "Weapon Recoil",
  "chance":                 "Status Chance",
};

const SPLIT_STAT_HEADS = new Set([
  "critical chance", "critical chance for",
  "additional combo", "additional combo count",
  "aditional combo", "aditional combo count",
  "chance to gain", "chance to gain combo",
  "finisher", "melee",
  "heavy attack", "heavy",
  "magazine",
  "fire rate", "fire rate x2", "fire rate x2 for",
  "critical chance x2", "critical chance x2 for",
  "status", "reload", "ammo", "weapon",
]);

function normForMerge(s: string): string {
  let n = s.toLowerCase().trim();
  n = n.replace(/[()]/g, "");
  n = n.replace(/\s+/g, " ");
  return n;
}

/**
 * Merge consecutive OCR lines that are fragments of a known multi-word stat.
 * e.g. ["..Critical Chance", "for Slide Attack.."] → ["..Critical Chance for Slide Attack.."]
 */
function mergeSplitLines(lines: string[]): string[] {
  if (lines.length <= 1) return lines;

  const merged: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNorm = normForMerge(line);
    let statPart = lineNorm.replace(/^[+\-x]?[\d.,]+%?\s*/, "").trim();
    statPart = statPart.replace(/[^a-z0-9 ]/g, "").trim();

    if (i + 1 < lines.length && SPLIT_STAT_HEADS.has(statPart)) {
      const nextNorm = normForMerge(lines[i + 1]);
      const nextClean = nextNorm.replace(/[^a-z0-9 ]/g, "").trim();
      if (nextClean in SPLIT_STAT_TAILS) {
        merged.push(line.trimEnd() + " " + lines[i + 1].trimStart());
        i += 2;
        continue;
      }
    }
    merged.push(line);
    i += 1;
  }
  return merged;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Full result from the YOLO + PaddleOCR pipeline. */
export interface RivenOcrResult {
  /** Recognized text lines (post-processed, merged), one per stat. */
  lines: OcrLineResult[];
  /** Combined text (lines joined with \n). */
  text: string;
  /** Minimum per-line CTC confidence across all lines. -1 if no lines. */
  minConfidence: number;
  /** Number of YOLO boxes detected. */
  yoloBoxCount: number;
}

/** Confidence threshold below which a stat line is considered unreliable. */
export const LOW_CONFIDENCE_THRESHOLD = 0.80;

/**
 * Run the full YOLO + PaddleOCR pipeline on a stat area image.
 *
 * @param rgbaBuf Raw RGBA buffer of the stat area (from Sharp)
 * @param W       Width of the stat area image
 * @param H       Height of the stat area image
 * @returns       OCR results with per-line confidence scores
 */
export async function recognizeStatArea(
  rgbaBuf: Buffer,
  W: number,
  H: number,
): Promise<RivenOcrResult> {
  // Step 1: YOLO detection
  const boxes = await yoloDetectStatLines(rgbaBuf, W, H);
  if (boxes.length === 0) {
    return { lines: [], text: "", minConfidence: -1, yoloBoxCount: 0 };
  }

  // Step 2: Extract + upscale crops
  const crops = await extractAndUpscaleCrops(rgbaBuf, W, H, boxes);
  if (crops.length === 0) {
    return { lines: [], text: "", minConfidence: -1, yoloBoxCount: boxes.length };
  }

  // Step 3: Batch PaddleOCR recognition
  const ocrResults = await recognizeCropsBatch(crops);

  // Step 4: Filter empty results and postprocess
  const validLines: OcrLineResult[] = [];
  for (const result of ocrResults) {
    const trimmed = result.text.trim();
    if (!trimmed) continue;
    const processed = postprocessOcrText(trimmed);
    if (processed.trim()) {
      validLines.push({ text: processed.trim(), confidence: result.confidence });
    }
  }

  // Step 5: Merge split lines
  const mergedTexts = mergeSplitLines(validLines.map((l) => l.text));

  // Rebuild lines with merged texts, carrying minimum confidence of merged fragments
  const mergedLines: OcrLineResult[] = [];
  let srcIdx = 0;
  for (const mergedText of mergedTexts) {
    let minConf = 1.0;

    // Consume source lines that are part of this merged text
    while (srcIdx < validLines.length) {
      const orig = validLines[srcIdx].text;
      if (mergedText === orig || mergedText.includes(orig)) {
        minConf = Math.min(minConf, validLines[srcIdx].confidence);
        srcIdx++;
        if (mergedText === orig) break;
      } else {
        break;
      }
    }

    if (srcIdx === 0 && validLines.length > 0) {
      minConf = validLines[0].confidence;
      srcIdx = 1;
    }

    mergedLines.push({ text: mergedText, confidence: minConf });
  }

  // Consume any remaining unmatched source lines
  while (srcIdx < validLines.length) {
    const remaining = validLines[srcIdx];
    mergedLines.push({ text: remaining.text, confidence: remaining.confidence });
    srcIdx++;
  }

  const text = mergedLines.map((l) => l.text).join("\n");
  const minConfidence = mergedLines.length > 0
    ? Math.min(...mergedLines.map((l) => l.confidence))
    : -1;

  return {
    lines: mergedLines,
    text,
    minConfidence,
    yoloBoxCount: boxes.length,
  };
}

/**
 * Check if any line in the result has low confidence.
 */
export function hasLowConfidenceLine(result: RivenOcrResult): boolean {
  return result.lines.some((l) => l.confidence < LOW_CONFIDENCE_THRESHOLD);
}

// ── Legacy exports (backward compatibility for benchmark scripts) ─────────────

export interface VgbLineResult {
  text: string;
  value: string;
  statName: string;
  labelConfidence: number;
  numericConfidence: number;
}

export interface VgbInputRegion {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

/** @deprecated Use recognizeStatArea() instead. */
export async function recognizeVgbLinesDetailed(
  _vgbPng: Buffer,
  _rowRegions?: VgbInputRegion[],
): Promise<VgbLineResult[]> {
  log.warn("[RivenOcrOnnx] recognizeVgbLinesDetailed() is deprecated — use recognizeStatArea()");
  return [];
}

/** @deprecated Use recognizeStatArea() instead. */
export async function recognizeVgbLines(_vgbPng: Buffer): Promise<string[]> {
  log.warn("[RivenOcrOnnx] recognizeVgbLines() is deprecated — use recognizeStatArea()");
  return [];
}

/** @deprecated Use recognizeStatArea() instead. */
export async function recognizeRivenCardLines(
  _cardPng: Buffer,
  _isMultipanel?: boolean,
  _statsOnlyMode?: boolean,
): Promise<string[]> {
  log.warn("[RivenOcrOnnx] recognizeRivenCardLines() is deprecated — use recognizeStatArea()");
  return [];
}

/** @deprecated Use recognizeStatArea() instead. */
export async function recognizeRivenCrop(_pngBuffer: Buffer, _isVgb?: boolean): Promise<string> {
  log.warn("[RivenOcrOnnx] recognizeRivenCrop() is deprecated — use recognizeStatArea()");
  return "";
}
