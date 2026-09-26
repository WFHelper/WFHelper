/** YOLO stat-line detection followed by PaddleOCR CH v3 recognition. */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { withScope } from "./logger";
import { resolveRuntimeResourcePath } from "./runtimeResources";
import { loadSharp } from "./sharpRuntime";

const log = withScope("rivenOcrOnnx");

/** Inference bursts run while Warframe renders, so the pool scales with core
 *  count: a fixed 4 threads starves a low-core machine and stutters the roll screen. */
function ortCpuSessionOptions() {
  const cores =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all" as const,
    interOpNumThreads: 1,
    intraOpNumThreads: Math.min(4, Math.max(2, cores - 4)),
  };
}

const RIVEN_OCR_ASSET_DIR = "riven-ocr";
const YOLO_MODEL_PARTS = [RIVEN_OCR_ASSET_DIR, "yolo", "stat_line_detector.onnx"] as const;
const CH_REC_MODEL_PARTS = [RIVEN_OCR_ASSET_DIR, "paddle", "ch_PP-OCRv3_rec_infer.onnx"] as const;
const CH_DICT_PARTS = [RIVEN_OCR_ASSET_DIR, "paddle", "ch_dict.txt"] as const;

/** Keeps ONNX tensor data unknown until each output kind is narrowed. */
interface OrtInferenceSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}

let _yoloSessionPromise: Promise<OrtInferenceSession> | null = null;
let _yoloInputName = "";
let _yoloInputSize = 640;

let _chRecSessionPromise: Promise<OrtInferenceSession> | null = null;
let _chDict: string[] = [];

// A missing model file won't fix itself, so don't retry the load on every
// call. Transient errors still clear the promise so the next call retries.
let _yoloSessionPermanentError: Error | null = null;
let _chRecSessionPermanentError: Error | null = null;

async function getYoloSession(): Promise<OrtInferenceSession> {
  if (_yoloSessionPermanentError) throw _yoloSessionPermanentError;
  if (_yoloSessionPromise) return _yoloSessionPromise;

  _yoloSessionPromise = (async () => {
    const modelPath = resolveRuntimeResourcePath(...YOLO_MODEL_PARTS);
    if (!existsSync(modelPath)) {
      const err = new Error(`YOLO model not found at ${modelPath}`);
      _yoloSessionPermanentError = err;
      throw err;
    }

    const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

    const session = await ort.InferenceSession.create(modelPath, ortCpuSessionOptions());

    _yoloInputName = session.inputNames[0];

    log.info(
      `[RivenOcrOnnx] YOLO detector loaded - input=${_yoloInputName} size=${_yoloInputSize}`,
    );
    return session;
  })().catch((err) => {
    _yoloSessionPromise = null;
    throw err;
  });

  return _yoloSessionPromise;
}

async function getChRecSession(): Promise<OrtInferenceSession> {
  if (_chRecSessionPermanentError) throw _chRecSessionPermanentError;
  if (_chRecSessionPromise) return _chRecSessionPromise;

  _chRecSessionPromise = (async () => {
    const modelPath = resolveRuntimeResourcePath(...CH_REC_MODEL_PARTS);
    const dictPath = resolveRuntimeResourcePath(...CH_DICT_PARTS);
    if (!existsSync(modelPath)) {
      const err = new Error(`PaddleOCR CH model not found at ${modelPath}`);
      _chRecSessionPermanentError = err;
      throw err;
    }

    const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

    // Split CRLF explicitly; leaving \r on dictionary characters corrupts CTC decoding.
    if (existsSync(dictPath)) {
      const dictContent = readFileSync(dictPath, "utf8");
      const lines = dictContent.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      _chDict = ["blank", ...lines];
    }

    const session = await ort.InferenceSession.create(modelPath, ortCpuSessionOptions());

    log.info(`[RivenOcrOnnx] PaddleOCR CH v3 loaded - ${_chDict.length} chars (incl. blank)`);
    return session;
  })().catch((err) => {
    _chRecSessionPromise = null;
    throw err;
  });

  return _chRecSessionPromise;
}

/** Checks whether both model files exist without loading them. */
export function rivenOcrOnnxAvailable(): boolean {
  return (
    existsSync(resolveRuntimeResourcePath(...YOLO_MODEL_PARTS)) &&
    existsSync(resolveRuntimeResourcePath(...CH_REC_MODEL_PARTS))
  );
}

interface YoloBox {
  y1: number;
  y2: number;
  x1: number;
  x2: number;
  confidence: number;
}

/** Detects stat boxes and returns them in vertical order. */
async function yoloDetectStatLines(
  rgbaBuf: Buffer,
  W: number,
  H: number,
  confThresh = 0.25,
  iouThresh = 0.5,
): Promise<YoloBox[]> {
  const session = await getYoloSession();

  const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

  const sharp = loadSharp();

  const imgsz = _yoloInputSize; // 640

  // Letterbox resize: scale to fit 640x640, center-pad with 114
  const scale = Math.min(imgsz / H, imgsz / W);
  const newW = Math.round(W * scale);
  const newH = Math.round(H * scale);
  const padLeft = Math.floor((imgsz - newW) / 2);
  const padTop = Math.floor((imgsz - newH) / 2);

  // Resize RGBA to newWxnewH, then extract RGB channels
  const resizedBuf: Buffer = await sharp(rgbaBuf, { raw: { width: W, height: H, channels: 4 } })
    .resize(newW, newH, { kernel: "linear" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Build padded 640x640 blob in CHW format, RGB, normalized 0-1
  const blobSize = 3 * imgsz * imgsz;
  const blob = new Float32Array(blobSize);
  const fillVal = 114 / 255;
  blob.fill(fillVal);

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = (y * newW + x) * 3;
      const dstY = y + padTop;
      const dstX = x + padLeft;
      blob[0 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx] / 255; // R
      blob[1 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx + 1] / 255; // G
      blob[2 * imgsz * imgsz + dstY * imgsz + dstX] = resizedBuf[srcIdx + 2] / 255; // B
    }
  }

  const tensor = new ort.Tensor("float32", blob, [1, 3, imgsz, imgsz]);
  const output = await session.run({ [_yoloInputName]: tensor });

  const outputName = session.outputNames[0];
  const preds = output[outputName].data as Float32Array;
  const predDims = output[outputName].dims;

  const boxes: Array<{ conf: number; y1: number; y2: number; x1: number; x2: number }> = [];

  if (predDims.length === 3) {
    // Shape [1, 5, N] - transposed format
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

const MAX_STAT_CROP_HEIGHT = 80;
const MIN_OCR_WIDTH = 1200;

export interface RgbCrop {
  data: Buffer;
  width: number;
  height: number;
}

/** Extracts padded RGB crops and uniformly upscales them for recognition. */
async function extractAndUpscaleCrops(
  rgbaBuf: Buffer,
  W: number,
  H: number,
  boxes: YoloBox[],
  padY = 8,
  padX = 8,
): Promise<RgbCrop[]> {
  if (boxes.length === 0) return [];

  const sharp = loadSharp();

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

/** Per-line OCR result with confidence score. */
interface OcrLineResult {
  text: string;
  confidence: number;
  /** One entry per character of text. */
  charConfidences?: number[];
}

/** True when the PaddleOCR recognizer model + dict are on disk (YOLO not required). */
export function paddleRecognizerAvailable(): boolean {
  return (
    existsSync(resolveRuntimeResourcePath(...CH_REC_MODEL_PARTS)) &&
    existsSync(resolveRuntimeResourcePath(...CH_DICT_PARTS))
  );
}

/** Run the shared PaddleOCR recognizer on raw RGB crops (used by the reward scanner too). */
export function recognizePaddleCrops(crops: RgbCrop[]): Promise<OcrLineResult[]> {
  return recognizeCropsBatch(crops);
}

/** Greedy-decodes CTC output and returns text with mean softmax confidence. */
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
  const confidence =
    confParts.length > 0 ? confParts.reduce((a, b) => a + b, 0) / confParts.length : 0;

  return { text, confidence, charConfidences: confParts };
}

// The element icon after a whole value decodes as one non-ASCII glyph; on 263
// benchmark cards that glyph alone held a correct "+167,3% Impact" line at 0.799.
const ICON_GLYPH_AFTER_VALUE =
  /^([+\-\u2013x\u00d7]?\s*\d(?:[\d.,]*\d)?(?:%\s*|\s+))([\u0080-\uffff])(?=\s*[A-Za-z])/;

// The crop padding decodes as edge spaces at 0.5-0.7 that trim() drops; counted,
// they pulled a correct "+86,5% Heat" icon line from 0.811 to 0.799, under the gate.
export function trimmedLineConfidence(result: OcrLineResult): number {
  const confs = result.charConfidences;
  if (!confs || confs.length !== result.text.length) return result.confidence;
  const start = result.text.length - result.text.trimStart().length;
  const end = result.text.trimEnd().length;
  if (end <= start) return result.confidence;
  const kept = confs.slice(start, end);
  const icon = ICON_GLYPH_AFTER_VALUE.exec(result.text.slice(start, end));
  if (icon) kept.splice(icon[1].length, icon[2].length);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// PP-OCRv3 pads every crop in a batch out to the widest one, so an 80:1 panel
// rule beside nine text lines costs 667MB and freezes the main process. Aspect
// cannot tell a rule from text, because their ranges overlap, so crops group by
// width instead and only budget-busting singles are dropped.
const REC_IMG_HEIGHT = 48;
const REC_MAX_CHUNK = 6;
const REC_OUTPUT_BUDGET = 48 * 1024 * 1024;
// Padding a 691px crop out to a 3934px rule spends 5.7x the compute on zeros.
const REC_MAX_PAD_STRETCH = 2;

function cropWidthAt48(crop: RgbCrop): number {
  return Math.ceil(REC_IMG_HEIGHT * (crop.width / crop.height));
}

function outputBytes(count: number, imgW: number): number {
  return count * Math.ceil(imgW / 8) * Math.max(1, _chDict.length) * 4;
}

/** Crop indices grouped by width, each group small enough to decode at once. */
function recognitionChunks(crops: RgbCrop[]): number[][] {
  const order = crops.map((_, index) => index);
  order.sort((a, b) => cropWidthAt48(crops[a]) - cropWidthAt48(crops[b]));

  const chunks: number[][] = [];
  let current: number[] = [];
  let currentW = 0;
  for (const index of order) {
    const width = cropWidthAt48(crops[index]);
    // Real stat lines top out near 59:1, so a crop that busts the budget on its own
    // is a detector artifact; padding it to 48px tall would allocate over 100MB.
    if (outputBytes(1, width) > REC_OUTPUT_BUDGET) {
      const crop = crops[index];
      log.warn(`[RivenOcrOnnx] skipped ${crop.width}x${crop.height} crop over the decode budget`);
      continue;
    }
    const merged = Math.max(currentW, width);
    const narrowest = current.length > 0 ? cropWidthAt48(crops[current[0]]) : width;
    const fits =
      current.length < REC_MAX_CHUNK &&
      merged <= narrowest * REC_MAX_PAD_STRETCH &&
      outputBytes(current.length + 1, merged) <= REC_OUTPUT_BUDGET;
    if (current.length > 0 && !fits) {
      chunks.push(current);
      current = [];
      currentW = 0;
    }
    current.push(index);
    currentW = Math.max(currentW, width);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Recognizes crops in width-sorted chunks so one wide crop only pads its own kind. */
async function recognizeCropsBatch(crops: RgbCrop[]): Promise<OcrLineResult[]> {
  if (crops.length === 0) return [];
  const session = await getChRecSession();

  const results: OcrLineResult[] = crops.map(() => ({ text: "", confidence: 0 }));
  for (const indices of recognitionChunks(crops)) {
    const chunk = await recognizeChunk(
      session,
      indices.map((index) => crops[index]),
    );
    for (let slot = 0; slot < indices.length; slot++) results[indices[slot]] = chunk[slot];
  }
  return results;
}

/** Aspect-preserving resize, normalization, and padding into one batch tensor. */
async function recognizeChunk(
  session: OrtInferenceSession,
  crops: RgbCrop[],
): Promise<OcrLineResult[]> {
  const ort: typeof import("onnxruntime-node") = require("onnxruntime-node");

  const sharp = loadSharp();

  const imgH = REC_IMG_HEIGHT;

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
        batchData[batchOffset + 1 * imgH * imgW + y * imgW + x] =
          resizedBuf[srcIdx + 1] / 127.5 - 1.0;
        batchData[batchOffset + 2 * imgH * imgW + y * imgW + x] =
          resizedBuf[srcIdx + 2] / 127.5 - 1.0;
      }
    }
  }

  const tensor = new ort.Tensor("float32", batchData, [batchSize, 3, imgH, imgW]);
  const inputName = session.inputNames[0];
  const output = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const preds = output[outputName].data as Float32Array;
  const dims = output[outputName].dims;

  // dims: [batch, seq_len, num_classes]
  const seqLen = dims[1];
  const numClasses = dims[2];

  const results: OcrLineResult[] = [];
  for (let b = 0; b < batchSize; b++) {
    results.push(ctcGreedyDecode(preds, seqLen, numClasses, b));
  }

  return results;
}

/** Deterministic corrections for known PaddleOCR CH misreads (ports postprocess_ocr_text). */
function postprocessOcrText(text: string): string {
  // Strip asterisk-minus artifact: "*-74,2%" -> "-74,2%"
  text = text.replace(/\*-/g, "-");
  // Strip > before uppercase: ">Impact" -> "Impact"
  text = text.replace(/>([A-Z])/g, "$1");

  // Insert spaces before CamelCase boundaries
  text = text.replace(/%([A-Z])/g, (m) => m[0] + " " + m[1]);
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2");

  // Word join fixes
  text = text.replace(/Damageto/g, "Damage to");
  text = text.replace(/\bfor([A-Z])/g, "for $1");
  text = text.replace(/(\d)for\b/g, "$1 for");

  // Recover dropped 'x' prefix on multiplier lines
  text = text.replace(
    /(?:^|\n)(\*?)[A-Za-z]?(\d[,.]?\d*)\s*Damage\s+to\b/gm,
    (_, _star, num) => `x${num} Damage to`,
  );

  // Common letter misreads
  text = text.replace(/Mmpact/g, "Impact");
  text = text.replace(/%\s*mpact/g, "% Impact");

  // Sign + 'i' + digits -> sign + '1' + digits: "+i29,1%" -> "+129,1%"
  text = text.replace(/([+-])i(\d)/g, "$11$2");

  // x-multiplier: xi/xl -> x1
  text = text.replace(/\bx[il]([,.])/g, "x1$1");

  // Double-1: digit + i before separator
  text = text.replace(/(\d)i([,.])/g, "$11$2");

  // Spurious dots: "197.,9%" -> "197,9%"
  text = text.replace(/(\d)\.,(\d)/g, "$1,$2");
  text = text.replace(/(\d)\.\.(\d)/g, "$1.$2");

  // Space between digits: "+1 56,2%" -> "+156,2%"
  text = text.replace(/(\d) (\d)/g, "$1$2");

  // OCR misspelling
  text = text.replace(/\bAditional\b/g, "Additional");

  return text;
}

const SPLIT_STAT_TAILS: Record<string, string> = {
  "slide attack": "Critical Chance for Slide Attack",
  "for slide attack": "Critical Chance for Slide Attack",
  "for slide": "Critical Chance for Slide Attack",
  "count chance": "Additional Combo Count Chance",
  "combo count chance": "Additional Combo Count Chance",
  "combo count": "Chance to Gain Combo Count",
  "gain combo count": "Chance to Gain Combo Count",
  damage: "Finisher Damage",
  efficiency: "Heavy Attack Efficiency",
  "attack efficiency": "Heavy Attack Efficiency",
  capacity: "Magazine Capacity",
  "heavy attacks": "Critical Chance",
  "for heavy attacks": "Critical Chance",
  "x2 for heavy attacks": "Critical Chance",
  "for bows": "Fire Rate",
  "x2 for bows": "Fire Rate",
  duration: "Status Duration",
  speed: "Reload Speed",
  maximum: "Ammo Maximum",
  recoil: "Weapon Recoil",
  chance: "Status Chance",
};

const SPLIT_STAT_HEADS = new Set([
  "critical chance",
  "critical chance for",
  "additional combo",
  "additional combo count",
  "aditional combo",
  "aditional combo count",
  "chance to gain",
  "chance to gain combo",
  "finisher",
  "melee",
  "heavy attack",
  "heavy",
  "magazine",
  "fire rate",
  "fire rate x2",
  "fire rate x2 for",
  "critical chance x2",
  "critical chance x2 for",
  "status",
  "reload",
  "ammo",
  "weapon",
]);

function normForMerge(s: string): string {
  let n = s.toLowerCase().trim();
  n = n.replace(/[()]/g, "");
  n = n.replace(/\s+/g, " ");
  return n;
}

// A lone CJK glyph at 0.04-0.46 confidence (263 benchmark screenshots) is a mark,
// not text, and can sit between the two halves of a wrapped name.
const GLYPH_JUNK_LINE = /^[^A-Za-z0-9%+\-\u2013\u00d7]*$/;

/** Merges consecutive fragments of a known multi-word stat. */
export function mergeSplitLines(lines: OcrLineResult[]): OcrLineResult[] {
  const merged: OcrLineResult[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNorm = normForMerge(line.text);
    let statPart = lineNorm.replace(/^[+\-x]?[\d.,]+%?\s*/, "").trim();
    statPart = statPart.replace(/[^a-z0-9 ]/g, "").trim();

    // Tolerate a right-truncated head ("magazin" for "magazine") - the stat
    // crop clips the card edge, so the head fragment may be missing chars.
    const headMatches =
      SPLIT_STAT_HEADS.has(statPart) ||
      (statPart.length >= 4 && [...SPLIT_STAT_HEADS].some((head) => head.startsWith(statPart)));
    let next = i + 1;
    while (headMatches && next < lines.length && GLYPH_JUNK_LINE.test(lines[next].text)) next += 1;
    if (next < lines.length && headMatches) {
      const tail = lines[next];
      const nextClean = normForMerge(tail.text)
        .replace(/[^a-z0-9 ]/g, "")
        .trim();
      if (nextClean in SPLIT_STAT_TAILS) {
        merged.push({
          text: line.text.trimEnd() + " " + tail.text.trimStart(),
          confidence: Math.min(line.confidence, tail.confidence),
        });
        i = next + 1;
        continue;
      }
    }
    merged.push(line);
    i += 1;
  }
  return merged;
}

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
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

/** Runs detection and recognition on a raw RGBA stat-area image. */
export async function recognizeStatArea(
  rgbaBuf: Buffer,
  W: number,
  H: number,
): Promise<RivenOcrResult> {
  const boxes = await yoloDetectStatLines(rgbaBuf, W, H);
  if (boxes.length === 0) {
    return { lines: [], text: "", minConfidence: -1, yoloBoxCount: 0 };
  }

  const crops = await extractAndUpscaleCrops(rgbaBuf, W, H, boxes);
  if (crops.length === 0) {
    return { lines: [], text: "", minConfidence: -1, yoloBoxCount: boxes.length };
  }

  const ocrResults = await recognizeCropsBatch(crops);

  const validLines: OcrLineResult[] = [];
  for (const result of ocrResults) {
    const trimmed = result.text.trim();
    if (!trimmed) continue;
    const processed = postprocessOcrText(trimmed);
    if (processed.trim()) {
      validLines.push({ text: processed.trim(), confidence: trimmedLineConfidence(result) });
    }
  }

  const mergedLines = mergeSplitLines(validLines);

  const text = mergedLines.map((l) => l.text).join("\n");
  // Only stat-relevant lines (starting with a value marker) count for minConfidence;
  // title, MR footer, and continuation fragments are excluded.
  const statLineRe = /^[+\-x×]/i;
  const statConfs = mergedLines
    .filter((l) => statLineRe.test(l.text.trim()))
    .map((l) => l.confidence);
  const minConfidence =
    statConfs.length > 0
      ? Math.min(...statConfs)
      : mergedLines.length > 0
        ? Math.min(...mergedLines.map((l) => l.confidence))
        : -1;

  return {
    lines: mergedLines,
    text,
    minConfidence,
    yoloBoxCount: boxes.length,
  };
}

// Only value-prefixed lines gate confidence; x needs a digit so the garbled
// MR badge cannot veto a good read.
export function hasLowConfidenceLine(result: RivenOcrResult): boolean {
  const statLineRe = /^[+-]|^[x×]\s*\d/i;
  const statLines = result.lines.filter((l) => statLineRe.test(l.text.trim()));
  if (statLines.length === 0) return false;
  return statLines.some((l) => l.confidence < LOW_CONFIDENCE_THRESHOLD);
}
