"use strict";

/**
 * rivenOcrOnnx.ts
 * ---------------
 * ONNX-based riven text recognition using a hybrid multi-model pipeline:
 *
 *   1. Old CRNN (riven_rec.onnx) — reads the full stat line via CTC decoding.
 *      Used to extract the numeric value prefix (+126.2%, ×2.4, …).
 *   2. StatClassifier (label_classifier.onnx) — CNN image classifier that maps
 *      the right ~62% of each line (the stat name region) directly to one of
 *      46 known riven stat names.  Used when confidence ≥ 0.6.
 *   3. Edit-distance fallback — when classifier confidence < 0.6, the name
 *      fragment from CRNN is matched against KNOWN_STATS via edit distance.
 *
 * Model specs — CRNN (riven_rec.onnx):
 *   Input:  float32 [1, 1, 32, W]   grayscale, H=32, W=dynamic, values in [-1,1]
 *   Output: float32 [T, 1, C]       log-softmax CTC character probabilities
 *   Vocab:  70 characters + 1 CTC blank (blank_idx = 70)
 *
 * Model specs — StatClassifier (label_classifier.onnx):
 *   Input:  float32 [1, 1, 32, 192]  grayscale, normalized to [-1,1]
 *   Output: float32 [1, N_classes]   raw logits (softmax applied in code)
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

// ── Label classifier path resolution ─────────────────────────────────────────

function resolveLabelModelPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "label", "label_classifier.onnx"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "label", "label_classifier.onnx"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "label", "label_classifier.onnx"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveLabelClassesPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "label", "label_classes.json"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "label", "label_classes.json"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "label", "label_classes.json"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// ── Numeric CRNN path resolution ─────────────────────────────────────────────

function resolveNumericModelPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "numeric", "numeric_rec.onnx"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "numeric", "numeric_rec.onnx"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "numeric", "numeric_rec.onnx"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function resolveNumericVocabPath(): string {
  const candidates = [
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "numeric", "numeric_vocab.json"),
    path.join(__dirname, "..", "..", "scripts", "train-paddleocr", "output", "numeric", "numeric_vocab.json"),
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "numeric", "numeric_vocab.json"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// ── Lazy session ──────────────────────────────────────────────────────────────

interface VocabData {
  vocab: string[];
  blank_idx: number;
}

interface LabelClassesData {
  classes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sessionPromise: Promise<any> | null = null;
let _vocab: string[] = [];
let _blankIdx = 70;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _labelSessionPromise: Promise<any> | null = null;
let _labelClasses: string[] = [];

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLabelSession(): Promise<any> {
  if (_labelSessionPromise) return _labelSessionPromise;

  _labelSessionPromise = (async () => {
    const modelPath = resolveLabelModelPath();
    const classesPath = resolveLabelClassesPath();

    if (!existsSync(modelPath)) {
      throw new Error(`Label classifier model not found at ${modelPath}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const ort: any = require("onnxruntime-node");

    if (existsSync(classesPath)) {
      const data = JSON.parse(readFileSync(classesPath, "utf8")) as LabelClassesData;
      _labelClasses = data.classes;
    }

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });

    log.log(`[RivenOcrOnnx] Label classifier loaded — ${_labelClasses.length} classes`);
    return session;
  })().catch((err) => {
    _labelSessionPromise = null;
    throw err;
  });

  return _labelSessionPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _numericSessionPromise: Promise<any> | null = null;
let _numericVocab: string[] = [];
let _numericBlankIdx = 18;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getNumericSession(): Promise<any> {
  if (_numericSessionPromise) return _numericSessionPromise;

  _numericSessionPromise = (async () => {
    const modelPath = resolveNumericModelPath();
    const vocabPath = resolveNumericVocabPath();

    if (!existsSync(modelPath)) {
      return null; // NumericCRNN is optional — old CRNN handles values as fallback
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const ort: any = require("onnxruntime-node");

    if (existsSync(vocabPath)) {
      const data = JSON.parse(readFileSync(vocabPath, "utf8")) as VocabData;
      // The numeric vocab is stored as a single string — split to char array
      _numericVocab = typeof data.vocab === "string" ? (data.vocab as string).split("") : data.vocab;
      _numericBlankIdx = data.blank_idx;
    }

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });

    log.log(
      `[RivenOcrOnnx] NumericCRNN loaded — vocab=${_numericVocab.length} chars, blank=${_numericBlankIdx}`,
    );
    return session;
  })().catch((err) => {
    _numericSessionPromise = null;
    throw err;
  });

  return _numericSessionPromise;
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

// ── CTC beam search decode ────────────────────────────────────────────────────

/**
 * CTC beam search returning top-K candidates with log-probability scores.
 * Used by NumericCRNN to provide alternative value readings when greedy fails.
 */
function ctcBeamDecode(
  logProbs: Float32Array, T: number, C: number,
  vocab: string[], blankIdx: number,
  beamWidth = 6, topK = 5,
): Array<[string, number]> {
  // Normalize to log-probabilities per timestep
  const lp = new Float32Array(T * C);
  for (let t = 0; t < T; t++) {
    let maxVal = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = logProbs[t * C + c];
      if (v > maxVal) maxVal = v;
    }
    let sumExp = 0;
    for (let c = 0; c < C; c++) sumExp += Math.exp(logProbs[t * C + c] - maxVal);
    const logSumExp = Math.log(sumExp);
    for (let c = 0; c < C; c++) {
      lp[t * C + c] = logProbs[t * C + c] - maxVal - logSumExp;
    }
  }

  // beams: [prefix, lastCharIdx, accumulatedLogProb]
  let beams: Array<[string, number, number]> = [["", -1, 0.0]];

  for (let t = 0; t < T; t++) {
    const newBeams = new Map<string, [string, number, number]>();
    const setBeam = (key: string, val: [string, number, number]) => {
      const existing = newBeams.get(key);
      if (!existing || existing[2] < val[2]) newBeams.set(key, val);
    };

    for (const [prefix, lastIdx, score] of beams) {
      // Blank extension
      const blankScore = score + lp[t * C + blankIdx];
      setBeam(`${prefix}\0${blankIdx}`, [prefix, blankIdx, blankScore]);

      // Top character extensions
      const indices: number[] = [];
      for (let c = 0; c < C; c++) if (c !== blankIdx) indices.push(c);
      indices.sort((a, b) => lp[t * C + b] - lp[t * C + a]);
      const topN = Math.min(indices.length, beamWidth * 2);

      for (let i = 0; i < topN; i++) {
        const idx = indices[i];
        const charScore = score + lp[t * C + idx];
        if (idx === lastIdx) {
          // CTC collapse: same char, don't extend prefix
          setBeam(`${prefix}\0${idx}`, [prefix, idx, charScore]);
        } else {
          const newPrefix = prefix + (vocab[idx] ?? "");
          setBeam(`${newPrefix}\0${idx}`, [newPrefix, idx, charScore]);
        }
      }
    }

    // Prune to top beamWidth
    const sorted = Array.from(newBeams.values()).sort((a, b) => b[2] - a[2]);
    beams = sorted.slice(0, beamWidth);
  }

  // Merge beams with same prefix
  const merged = new Map<string, number>();
  for (const [prefix, , score] of beams) {
    const existing = merged.get(prefix);
    if (existing === undefined || existing < score) merged.set(prefix, score);
  }
  const results = Array.from(merged.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK) as Array<[string, number]>;
  return results.length > 0 ? results : [["", 0]];
}

// ── NumericCRNN inference ─────────────────────────────────────────────────────

/**
 * Recognize the numeric value from a line crop's left portion using NumericCRNN.
 * Returns top-K beam candidates: [(text, logProbScore), ...].
 */
async function recognizeNumericTopK(
  grayBuf: Buffer,
  srcW: number,
  srcH: number,
  beamWidth = 6,
  topK = 5,
): Promise<Array<[string, number]>> {
  const session = await getNumericSession();
  if (!session) return [["", 0]];

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const ort: any = require("onnxruntime-node");

  const { data } = await sharp(grayBuf, {
    raw: { width: srcW, height: srcH, channels: 1 },
  })
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = Math.round(((data as Buffer).length) / 32);
  const float32 = new Float32Array(W * 32);
  for (let i = 0; i < (data as Buffer).length; i++) {
    float32[i] = (data as Buffer)[i] / 127.5 - 1.0;
  }

  const tensor = new ort.Tensor("float32", float32, [1, 1, 32, W]);
  const output = await session.run({ input: tensor });
  const logProbs: Float32Array = output["output"]?.data ?? output["log_probs"]?.data ?? output["logits"]?.data;
  const [T, , C]: [number, number, number] = (output["output"]?.dims ?? output["log_probs"]?.dims ?? output["logits"]?.dims) ?? [0, 1, 1];

  return ctcBeamDecode(logProbs, T, C, _numericVocab, _numericBlankIdx, beamWidth, topK);
}

// ── Label classifier inference ────────────────────────────────────────────────

const LABEL_IMG_H = 32;
const LABEL_IMG_W = 192;

/**
 * Classify a stat label crop using the StatClassifier ONNX model.
 * Input: raw grayscale pixel buffer of the label region.
 * Returns [className, confidenceScore] or ["", 0] on failure.
 */
async function classifyStatLabel(
  grayBuf: Buffer,
  srcW: number,
  srcH: number,
): Promise<[string, number]> {
  if (_labelClasses.length === 0) return ["", 0];

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const ort: any = require("onnxruntime-node");

  const session = await getLabelSession();

  const { data } = await sharp(grayBuf, {
    raw: { width: srcW, height: srcH, channels: 1 },
  })
    .resize(LABEL_IMG_W, LABEL_IMG_H, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const float32 = new Float32Array(LABEL_IMG_H * LABEL_IMG_W);
  for (let i = 0; i < (data as Buffer).length; i++) {
    float32[i] = (data as Buffer)[i] / 127.5 - 1.0;
  }

  const tensor = new ort.Tensor("float32", float32, [1, 1, LABEL_IMG_H, LABEL_IMG_W]);
  const output = await session.run({ input: tensor });
  const logits: Float32Array = output["output"]?.data ?? output["logits"]?.data;
  const numClasses = _labelClasses.length;

  // Softmax → pick argmax + probability
  let maxLogit = -Infinity;
  for (let i = 0; i < numClasses; i++) if (logits[i] > maxLogit) maxLogit = logits[i];
  let sumExp = 0;
  const probs = new Float32Array(numClasses);
  for (let i = 0; i < numClasses; i++) { probs[i] = Math.exp(logits[i] - maxLogit); sumExp += probs[i]; }
  let bestIdx = 0, bestP = 0;
  for (let i = 0; i < numClasses; i++) {
    const p = probs[i] / sumExp;
    if (p > bestP) { bestP = p; bestIdx = i; }
  }

  return [_labelClasses[bestIdx] ?? "", bestP];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if an RGB pixel falls within the violet/purple hue range typical of
 * Warframe riven mod text.  Same logic as rivenScanImage.ts isVioletPixel.
 */
function isVioletPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 70) return false;
  if (max === 0 || delta / max < 0.06) return false;
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return hue >= 230 && hue <= 330;
}

/**
 * Apply violet color segmentation to an RGBA buffer, producing a grayscale
 * buffer where violet text pixels are white (255) and everything else is
 * black (0).  This bridges the domain gap between real screenshots (noisy
 * Kuva backgrounds) and the CRNN training data (clean text on dark).
 */
function violetSegmentRgba(rgba: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = isVioletPixel(rgba[i], rgba[i + 1], rgba[i + 2]) ? 255 : 0;
  }
  return out;
}

/**
 * Recognize text in a single riven stat line PNG crop.
 *
 * This covers RECOGNITION ONLY.  Feed it one detected text-region crop at a
 * time.  Returns the recognized text string.
 *
 * @param pngBuffer  PNG-encoded image of a single text line (any size).
 *                   Will be resized to height=32, keeping aspect ratio.
 * @param isVgb      true when the input has already been processed by the VGB
 *                   pipeline (black text on white).  When false, violet color
 *                   segmentation is applied first.
 */
export async function recognizeRivenCrop(pngBuffer: Buffer, isVgb = false): Promise<string> {
  const session = await getSession();

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");

  let grayBuf: Buffer;
  let rawW: number;
  let rawH: number;

  if (isVgb) {
    // VGB input is already black-on-white — just convert to grayscale
    const { data, info } = await sharp(pngBuffer)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    grayBuf = data as Buffer;
    rawW = info.width;
    rawH = info.height;
  } else {
    // Step 1: decode to RGBA for violet color segmentation
    const { data: rgbaData, info: rgbaInfo } = await sharp(pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rawW = rgbaInfo.width;
    rawH = rgbaInfo.height;

    // Step 2: violet color segmentation — isolate purple text, remove Kuva noise
    grayBuf = violetSegmentRgba(rgbaData as Buffer, rawW, rawH);
  }

  // Resize to H=32
  const { data, info } = await sharp(grayBuf, {
    raw: { width: rawW, height: rawH, channels: 1 },
  })
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0 } })
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
  const output = await session.run({ input: tensor });

  const logProbs: Float32Array = output["output"]?.data ?? output["log_probs"]?.data ?? output["logits"]?.data;
  const [T, , C]: [number, number, number] = (output["output"]?.dims ?? output["log_probs"]?.dims ?? output["logits"]?.dims) ?? [0, 1, 1];
  return greedyCtcDecode(logProbs, T, C);
}

// ── Known vocabulary for post-processing ─────────────────────────────────────

const STAT_RULES: Record<string, { isPercent?: boolean; suffix?: string; min?: number; max?: number }> = {
  "Punch Through": { isPercent: false, min: 0.1, max: 5.0 },
  "Range": { isPercent: false, min: 0.1, max: 4.0 },
  "Combo Duration": { isPercent: false, suffix: "s", min: 0.1, max: 15.0 },
  "Initial Combo": { isPercent: false, min: 1, max: 60 },
  "Zoom": { isPercent: true, min: 5, max: 120 },
  "Critical Chance": { isPercent: true, min: 10, max: 300 },
  "Critical Damage": { isPercent: true, min: 10, max: 200 },
  "Multishot": { isPercent: true, min: 10, max: 250 },
  "Status Chance": { isPercent: true, min: 10, max: 200 },
  "Status Duration": { isPercent: true, min: 10, max: 200 },
  "Fire Rate": { isPercent: true, min: 10, max: 200 },
  "Magazine Capacity": { isPercent: true, min: 10, max: 200 },
  "Ammo Maximum": { isPercent: true, min: 10, max: 200 },
  "Melee Damage": { isPercent: true, min: 30, max: 300 },
  "Impact": { isPercent: true, min: 10, max: 200 },
  "Puncture": { isPercent: true, min: 10, max: 200 },
  "Slash": { isPercent: true, min: 10, max: 200 },
  "Electricity": { isPercent: true, min: 10, max: 200 },
  "Cold": { isPercent: true, min: 10, max: 200 },
  "Heat": { isPercent: true, min: 10, max: 200 },
  "Toxin": { isPercent: true, min: 10, max: 200 },
  "Reload Speed": { isPercent: true, min: 10, max: 200 },
  "Attack Speed": { isPercent: true, min: 10, max: 200 },
  "Projectile Speed": { isPercent: true, min: 10, max: 200 },
  "Finisher Damage": { isPercent: true, min: 20, max: 200 },
  "Damage": { isPercent: true, min: 30, max: 400 },
  "Heavy Attack": { isPercent: true, min: 20, max: 200 },
  "Heavy Attack Efficiency": { isPercent: true, min: 20, max: 200 },
  "Chance to Gain Combo Count": { isPercent: true, min: 10, max: 200 },
  "Additional Combo Count Chance": { isPercent: true, min: 10, max: 200 },
  "Weapon Recoil": { isPercent: true, min: 10, max: 200 },
  "Flight Speed": { isPercent: true, min: 10, max: 200 },
  "Critical Chance for Slide Attack": { isPercent: true, min: 20, max: 300 },
  "Damage to Grineer": { isPercent: false, min: 0.3, max: 4.0 },
  "Damage to Corpus": { isPercent: false, min: 0.3, max: 4.0 },
  "Damage to Infested": { isPercent: false, min: 0.3, max: 4.0 },
};

const KNOWN_STATS = [
  "Additional Combo Count Chance", "Chance to Gain Combo Count",
  "Critical Chance for Slide Attack", "Heavy Attack Efficiency",
  "Magazine Capacity", "Damage to Grineer", "Damage to Corpus",
  "Damage to Infested", "Critical Chance", "Critical Damage",
  "Finisher Damage", "Melee Damage", "Weapon Recoil", "Status Duration",
  "Status Chance", "Projectile Speed", "Reload Speed", "Attack Speed",
  "Flight Speed", "Fire Rate", "Punch Through", "Combo Duration",
  "Initial Combo", "Ammo Maximum", "Heavy Attack", "Channeling Damage",
  "Channeling Efficiency", "Multishot", "Electricity", "Corrosive",
  "Radiation", "Magnetic", "Cold", "Heat", "Toxin", "Viral", "Blast",
  "Gas", "Impact", "Puncture", "Slash", "Magazine", "Recoil", "Damage",
  "Range", "Slide", "Zoom",
];

function editDistance(a: string, b: string): number {
  if (a.length < b.length) return editDistance(b, a);
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1, ...new Array<number>(b.length).fill(0)];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

function validateStat(valueStr: string, statName: string): [string, string] {
  if (!statName || !KNOWN_STATS.includes(statName)) {
    return [valueStr, statName];
  }

  if (!valueStr) {
    return [valueStr, statName];
  }

  let rules = STAT_RULES[statName];
  if (!rules) {
    return [valueStr, statName];
  }

  let result = valueStr;

  // Add missing suffix (e.g., 's' for Combo Duration)
  if (rules.suffix && !result.endsWith(rules.suffix)) {
    result = result + rules.suffix;
  }

  // Strip percent from flat stats
  if (rules.isPercent === false && result.includes("%")) {
    result = result.replace("%", "");
  }

  // ── Prefix/suffix vs stat type consistency (multiplier redirect) ──
  const MULTIPLIER_STATS = ["Damage to Grineer", "Damage to Corpus", "Damage to Infested"];
  if (MULTIPLIER_STATS.includes(statName) && result && !result.startsWith("x")) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null) {
      const mag = Math.abs(parsed);
      let bestCandidate: string | null = null;
      for (const [candidate, crules] of Object.entries(STAT_RULES)) {
        if (crules.isPercent && !MULTIPLIER_STATS.includes(candidate)) {
          if ((crules.min ?? 0) <= mag && mag <= (crules.max ?? 99999)) {
            if (mag > 100 && (candidate === "Melee Damage" || candidate === "Damage")) {
              bestCandidate = candidate;
              break;
            } else if (!bestCandidate) {
              bestCandidate = candidate;
            }
          }
        }
      }
      if (bestCandidate) {
        statName = bestCandidate;
        rules = STAT_RULES[statName] ?? rules;
        if (rules.isPercent && !result.includes("%")) {
          result = result + "%";
        }
      }
    }
  }

  // ── Phantom-comma removal ──
  if (rules.min != null && result.includes(",")) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null && Math.abs(parsed) < rules.min) {
      const noComma = result.replace(",", "");
      const alt = tryParseNumeric(noComma);
      if (alt !== null && rules.min <= Math.abs(alt) && Math.abs(alt) <= (rules.max ?? 99999)) {
        result = noComma;
      }
    }
  }

  // ── Comma-reposition ──
  // When value has comma and is out of range, try repositioning the comma
  // across all digit positions. Only uses the OCR's own digits.
  if (rules.min != null && result.includes(",")) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null) {
      const statMin = rules.min;
      const statMax = rules.max ?? 99999;
      const outOfRange = Math.abs(parsed) < statMin || Math.abs(parsed) > statMax * 1.5;
      if (outOfRange) {
        const crMatch = result.trim().match(/^([+\-x]?)(\d+),(\d*)(.*)/);
        if (crMatch) {
          const [, prefix, intPart, decPart, suffix] = crMatch;
          const digits = intPart + decPart;
          let bestCand: string | null = null;
          let bestDist = Infinity;
          for (let i = 1; i < digits.length; i++) {
            const cand = `${prefix}${digits.slice(0, i)},${digits.slice(i)}${suffix}`;
            const cp = tryParseNumeric(cand);
            if (cp !== null && statMin <= Math.abs(cp) && Math.abs(cp) <= statMax) {
              const dist = Math.abs(parsed) < statMin
                ? Math.abs(cp) - statMin
                : statMax - Math.abs(cp);
              if (dist < bestDist) {
                bestDist = dist;
                bestCand = cand;
              }
            }
          }
          if (bestCand) result = bestCand;
        }
      }
    }
  }

  // ── Phantom-digit removal ──
  if (rules.max != null && result.includes(",")) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null && Math.abs(parsed) > (rules.max ?? 99999) * 1.5) {
      const pdMatch = result.match(/^([+\-x]?)(\d+),(\d+)(.*)/);
      if (pdMatch) {
        const [, prefix, intPart, decPart, suffix] = pdMatch;
        for (let i = 0; i < intPart.length; i++) {
          const shorter = intPart.slice(0, i) + intPart.slice(i + 1);
          if (shorter) {
            const candidate = `${prefix}${shorter},${decPart}${suffix}`;
            const alt = tryParseNumeric(candidate);
            if (alt !== null && (rules.min ?? 0) <= Math.abs(alt) && Math.abs(alt) <= (rules.max ?? 99999)) {
              result = candidate;
              break;
            }
          }
        }
      }
    }
  }

  // ── Dropped-comma insertion ──
  if (rules.max != null && !result.includes(",")) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null && Math.abs(parsed) > (rules.max ?? 99999) * 1.5) {
      const dcMatch = result.match(/^([+\-x])(\d{3,})(.*)/);
      if (dcMatch) {
        const [, prefix, digits, suffix] = dcMatch;
        const withComma = prefix + digits.slice(0, -1) + "," + digits.slice(-1) + suffix;
        const alt = tryParseNumeric(withComma);
        if (alt !== null && (rules.min ?? 0) <= Math.abs(alt) && Math.abs(alt) <= (rules.max ?? 99999)) {
          result = withComma;
        }
      }
    }
  }

  // ── Over-inflated flat-value recovery ──
  if (rules.max != null) {
    const parsed = tryParseNumeric(result);
    if (parsed !== null && Math.abs(parsed) > (rules.max ?? 99999) * 1.5 && (rules.max ?? 99999) < 100) {
      const deflated = parsed / 100.0;
      if ((rules.min ?? 0) <= Math.abs(deflated) && Math.abs(deflated) <= (rules.max ?? 99999)) {
        const prefix = result.startsWith("x") ? "x" : (parsed >= 0 ? "+" : "-");
        const suffixChar = rules.suffix ?? "";
        const absVal = Math.abs(deflated);
        result = absVal === Math.floor(absVal)
          ? `${prefix}${Math.floor(absVal)}${suffixChar}`
          : `${prefix}${absVal.toFixed(1).replace(".", ",")}${suffixChar}`;
      }
    }
  }

  return [result, statName];
}

// ── Value ensemble: pick best from old CRNN and NumericCRNN ──────────────────

function pickBestValue(oldValue: string, numericValue: string): string {
  if (!oldValue && !numericValue) return "";
  if (!oldValue) return numericValue;
  if (!numericValue) return oldValue;

  const oldParsed = tryParseNumeric(oldValue);
  const numParsed = tryParseNumeric(numericValue);

  if (oldParsed === null && numParsed !== null) return numericValue;
  if (numParsed === null) return oldValue;

  const oldMag = Math.abs(oldParsed!);
  const numMag = Math.abs(numParsed!);

  // Phantom comma in old CRNN: old reads +15,7% (15.7), numeric reads +157%
  if (numMag > 0 && oldMag > 0) {
    const ratio = numMag / oldMag;
    if (ratio > 8.0 && ratio < 12.0 && oldValue.includes(",") &&
        !numericValue.replace("x", "").includes(",") && oldMag < 30) {
      return numericValue;
    }
  }

  // Numeric much larger — old may have edge artifact
  if (numMag > 0 && oldMag > 0 && oldMag < 10) {
    const ratio = numMag / oldMag;
    if (ratio > 5.0) {
      const hasSuffix = oldValue.endsWith("s");
      const bothMult = oldValue.startsWith("x") && numericValue.startsWith("x");
      if (!hasSuffix && !bothMult) return numericValue;
    }
  }

  // Sign mismatch with diverging magnitudes
  const oldSign = oldValue[0] ?? "";
  const numSign = numericValue[0] ?? "";
  if (oldSign !== numSign && "+-".includes(oldSign) && "+-".includes(numSign) &&
      numMag > 20 && oldMag < numMag * 1.5) {
    const magRatio = numMag > 0 ? oldMag / numMag : 0;
    if (magRatio < 0.90 || magRatio > 1.10) return numericValue;
  }

  // Default: old CRNN preserves commas better
  return oldValue;
}

/**
 * Enhanced value picking with beam search + STAT_RULES validation.
 * Tries alternative beam candidates when greedy value fails range check.
 */
function pickBestValueWithBeam(
  oldValue: string,
  numericCandidates: Array<[string, number]>,
  statName: string,
): string {
  const greedyNum = numericCandidates.length > 0 ? numericCandidates[0][0] : "";
  const bestValue = pickBestValue(oldValue, greedyNum);

  const rules = STAT_RULES[statName];
  if (!rules || !statName) return bestValue;

  const greedyParsed = tryParseNumeric(bestValue);
  const statMin = rules.min ?? 0;
  const statMax = rules.max ?? 99999;
  if (greedyParsed !== null && statMin <= Math.abs(greedyParsed) && Math.abs(greedyParsed) <= statMax) {
    return bestValue; // Greedy in range
  }

  // Try alternative beam candidates
  for (let i = 1; i < numericCandidates.length; i++) {
    const candText = numericCandidates[i][0];
    if (!candText) continue;
    const candVal = pickBestValue(oldValue, candText);
    const candParsed = tryParseNumeric(candVal);
    if (candParsed !== null && statMin <= Math.abs(candParsed) && Math.abs(candParsed) <= statMax) {
      return candVal;
    }
  }

  return bestValue; // No beam validates — validateStat may fix it
}

// ── Spatial split: separate numeric value from stat label ────────────────────

/**
 * Split a VGB line crop (grayscale buffer) into numeric (left) and label (right)
 * portions using column density gap detection.
 * Returns [numericBuf, labelBuf, numW, labelW] or [fullBuf, null, fullW, 0] if
 * no split found.
 */
function splitValueAndLabel(
  grayBuf: Buffer, w: number, h: number,
): { numBuf: Buffer; numW: number; labelBuf: Buffer | null; labelW: number } {
  if (w < 60) return { numBuf: grayBuf, numW: w, labelBuf: null, labelW: 0 };

  // Binarize: dark pixels = text (VGB black-on-white)
  const binary = Buffer.alloc(w * h);
  for (let i = 0; i < grayBuf.length; i++) {
    binary[i] = grayBuf[i] < 180 ? 255 : 0;
  }

  // Column density
  const colDensity = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) {
      if (binary[y * w + x] > 0) count++;
    }
    colDensity[x] = count / h;
  }

  // Smooth
  const ks = Math.max(3, Math.floor(w / 40)) | 1; // ensure odd
  const smoothed = new Float32Array(w);
  const half = (ks - 1) / 2;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const idx = x + k;
      if (idx >= 0 && idx < w) { sum += colDensity[idx]; cnt++; }
    }
    smoothed[x] = sum / cnt;
  }

  // Find gaps
  const gapThresh = 0.02;
  const gaps: Array<[number, number, number]> = [];
  let inGap = false;
  let gapStart = 0;
  for (let x = 0; x < w; x++) {
    if (smoothed[x] < gapThresh) {
      if (!inGap) { gapStart = x; inGap = true; }
    } else {
      if (inGap && x - gapStart >= 4) {
        gaps.push([gapStart, x, x - gapStart]);
      }
      inGap = false;
    }
  }
  if (inGap && w - gapStart >= 4) {
    gaps.push([gapStart, w, w - gapStart]);
  }

  if (gaps.length === 0) return { numBuf: grayBuf, numW: w, labelBuf: null, labelW: 0 };

  // Find widest gap between 10-80% of width
  let best: [number, number, number] | null = null;
  for (const gap of gaps) {
    const center = (gap[0] + gap[1]) / 2;
    const rel = center / w;
    if (rel > 0.10 && rel < 0.80 && gap[2] >= 5) {
      if (!best || gap[2] > best[2]) best = gap;
    }
  }

  if (!best) return { numBuf: grayBuf, numW: w, labelBuf: null, labelW: 0 };

  const numW = best[0];
  const labelStart = best[1];
  const labelW = w - labelStart;
  const minNumW = Math.max(15, Math.floor(w * 0.08));

  if (numW < minNumW || labelW < 20) {
    // Try second-widest gap
    let secondBest: [number, number, number] | null = null;
    for (const gap of gaps) {
      const center = (gap[0] + gap[1]) / 2;
      const rel = center / w;
      if (rel > 0.10 && rel < 0.80 && gap[2] >= 5 && gap !== best) {
        if (!secondBest || gap[2] > secondBest[2]) secondBest = gap;
      }
    }
    if (secondBest) {
      const nW = secondBest[0];
      const lS = secondBest[1];
      const lW = w - lS;
      if (nW >= minNumW && lW >= 20) {
        const nBuf = extractColumns(grayBuf, w, h, 0, nW);
        const lBuf = extractColumns(grayBuf, w, h, lS, lW);
        return { numBuf: nBuf, numW: nW, labelBuf: lBuf, labelW: lW };
      }
    }
    return { numBuf: grayBuf, numW: w, labelBuf: null, labelW: 0 };
  }

  const nBuf = extractColumns(grayBuf, w, h, 0, numW);
  const lBuf = extractColumns(grayBuf, w, h, labelStart, labelW);
  return { numBuf: nBuf, numW: numW, labelBuf: lBuf, labelW: labelW };
}

/**
 * Extract a column range from a grayscale buffer.
 */
function extractColumns(src: Buffer, srcW: number, h: number, startX: number, width: number): Buffer {
  const dst = Buffer.alloc(width * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      dst[y * width + x] = src[y * srcW + startX + x];
    }
  }
  return dst;
}

function tryParseNumeric(val: string): number | null {
  let s = val.trim();
  if (!s) return null;
  let sign = 1;
  if (s[0] === "-") { sign = -1; s = s.slice(1); }
  else if (s[0] === "+" || s[0] === "x") { s = s.slice(1); }
  s = s.replace(/%$/, "").replace(/s$/, "");
  s = s.replace(/,/g, ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : sign * n;
}

function postprocessStatLine(rawText: string): string {
  const text = rawText.trim();
  if (!text) return text;

  const match = text.match(/^([+\-x][\d,.]+%?)\s*(.*)/);
  const valuePart = match ? match[1] : "";
  const namePart = (match ? match[2] : text).trim();
  if (!namePart) return text;

  let bestStat: string | null = null;
  let bestDist = Infinity;
  const nameLower = namePart.toLowerCase();

  for (const stat of KNOWN_STATS) {
    const dist = editDistance(nameLower, stat.toLowerCase());
    const maxLen = Math.max(namePart.length, stat.length);
    const normDist = dist / Math.max(1, maxLen);
    if (dist < bestDist && normDist < 0.35) {
      bestDist = dist;
      bestStat = stat;
    }
  }

  if (bestStat) {
    return valuePart ? `${valuePart} ${bestStat}` : bestStat;
  }
  return text;
}

// ── VGB line extraction + CRNN recognition ──────────────────────────────────

export interface VgbLineResult {
  text: string;
  value: string;
  statName: string;
  labelConfidence: number;
  /** Best NumericCRNN beam candidate log-probability (0 if unavailable) */
  numericConfidence: number;
}

/**
 * Extract per-line crops from a VGB-processed PNG (black text on white),
 * recognize each with the multi-model pipeline, and apply post-processing.
 *
 * Returns rich per-line results including confidence scores.
 */
export async function recognizeVgbLinesDetailed(vgbPng: Buffer): Promise<VgbLineResult[]> {
  const lines = await _recognizeVgbLinesInternal(vgbPng);
  return lines;
}

/**
 * Extract per-line crops from a VGB-processed PNG (black text on white),
 * recognize each with the CRNN model, and apply post-processing.
 *
 * This is the main entry point for VGB+CRNN recognition.
 *
 * @param vgbPng  PNG buffer of the full VGB output (grayscale, black-on-white)
 * @returns       Recognized text lines (post-processed against known vocabulary)
 */
export async function recognizeVgbLines(vgbPng: Buffer): Promise<string[]> {
  const detailed = await _recognizeVgbLinesInternal(vgbPng);
  return detailed.map((r) => r.text);
}

async function _recognizeVgbLinesInternal(vgbPng: Buffer): Promise<VgbLineResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");

  // Decode VGB image to raw grayscale
  const { data, info } = await sharp(vgbPng)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gray = data as Buffer;
  const W: number = info.width;
  const H: number = info.height;

  // ── Step 1: Detect text rows using dark pixel density ──
  // In VGB output (black-on-white), text pixels are dark (< 128).
  const rowDensity = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let count = 0;
    for (let x = 0; x < W; x++) {
      if (gray[y * W + x] < 128) count++;
    }
    rowDensity[y] = count;
  }
  const meanDensity = rowDensity.reduce((a, b) => a + b, 0) / H;
  const rowThresh = Math.max(5, meanDensity * 0.3);

  const textRows: Array<{ yStart: number; yEnd: number }> = [];
  let inRow = false;
  let rowStart = 0;
  for (let y = 0; y < H; y++) {
    if (rowDensity[y] >= rowThresh) {
      if (!inRow) { rowStart = y; inRow = true; }
    } else {
      if (inRow && y - rowStart >= 6) {
        textRows.push({ yStart: rowStart, yEnd: y });
      }
      inRow = false;
    }
  }
  if (inRow && H - rowStart >= 6) {
    textRows.push({ yStart: rowStart, yEnd: H });
  }

  if (textRows.length === 0) return [];

  // ── Step 2: For each row, find horizontal text extent and extract crop ──
  const padY = 4;
  const lines: VgbLineResult[] = [];

  for (const row of textRows) {
    const y0 = Math.max(0, row.yStart - padY);
    const y1 = Math.min(H, row.yEnd + padY);
    const rowH = y1 - y0;
    if (rowH < 8) continue;

    // Find horizontal extent of dark pixels in this row
    let xMin = W, xMax = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        if (gray[y * W + x] < 128) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
        }
      }
    }
    if (xMax <= xMin + 20) continue; // too narrow

    // Add small horizontal padding
    const xPad = Math.floor(W * 0.01);
    xMin = Math.max(0, xMin - xPad);
    xMax = Math.min(W - 1, xMax + xPad);
    const cropW = xMax - xMin + 1;

    if (cropW < 30) continue;

    // Tight vertical bounds across the full horizontal extent (preserves both
    // value prefix and stat name — fixes the old "widest run" truncation bug).
    let tyMin = rowH, tyMax = 0;
    for (let ry = 0; ry < rowH; ry++) {
      for (let cx = 0; cx < cropW; cx++) {
        if (gray[(y0 + ry) * W + (xMin + cx)] < 128) {
          if (ry < tyMin) tyMin = ry;
          tyMax = ry;
          break;
        }
      }
    }
    if (tyMax - tyMin < 4) continue;

    const finalY0 = y0 + Math.max(0, tyMin - 2);
    const finalY1 = y0 + Math.min(rowH, tyMax + 3);
    const finalH = finalY1 - finalY0;
    if (finalH < 6) continue;

    // ── Step 3: Extract grayscale line crop for spatial split + multi-model ──
    const lineGray = Buffer.alloc(cropW * finalH);
    for (let ry = 0; ry < finalH; ry++) {
      for (let cx = 0; cx < cropW; cx++) {
        lineGray[ry * cropW + cx] = gray[(finalY0 + ry) * W + (xMin + cx)];
      }
    }

    // Full-line old CRNN (value + name text)
    const linePng: Buffer = await sharp(lineGray, {
      raw: { width: cropW, height: finalH, channels: 1 },
    }).png().toBuffer();

    const rawText = (await recognizeRivenCrop(linePng, /* isVgb */ true)).trim();
    if (!rawText) continue;

    // Extract value prefix and name fragment from old CRNN output
    const valueMatch = rawText.match(/^([+\-x][\d,.]+[%s]?)\s*/i);
    const oldValue = valueMatch ? valueMatch[1] : "";
    const nameFragment = rawText.replace(/^[+\-x][\d,.]+[%s]?\s*/i, "").trim();

    // ── Step 4: Spatial split via column density gap detection ──
    const split = splitValueAndLabel(lineGray, cropW, finalH);

    // ── Step 5: NumericCRNN beam search on numeric (left) portion ──
    let numericCandidates: Array<[string, number]> = [];
    try {
      numericCandidates = await recognizeNumericTopK(split.numBuf, split.numW, finalH);
    } catch {
      // NumericCRNN not available — value ensemble falls back to old CRNN only
    }

    // ── Step 6: Classify stat label from split label portion (or fallback) ──
    let statName = "";
    let labelConf = 0;
    if (split.labelBuf && split.labelW >= 20) {
      try {
        const [className, confidence] = await classifyStatLabel(
          split.labelBuf, split.labelW, finalH,
        );
        if (confidence >= 0.5 && className) {
          statName = className;
          labelConf = confidence;
        }
      } catch {
        // classifier not available
      }
    }
    // Fallback: classify from fixed 62% right portion
    if (!statName) {
      const labelX0 = xMin + Math.floor(cropW * 0.38);
      const labelW = cropW - Math.floor(cropW * 0.38);
      if (labelW >= 20) {
        try {
          const { data: labelRaw } = await sharp(gray, {
            raw: { width: W, height: H, channels: 1 },
          })
            .extract({ left: labelX0, top: finalY0, width: labelW, height: finalH })
            .raw()
            .toBuffer({ resolveWithObject: true });
          const [className, confidence] = await classifyStatLabel(
            labelRaw as Buffer, labelW, finalH,
          );
          if (confidence >= 0.5 && className) {
            statName = className;
            labelConf = confidence;
          }
        } catch {
          // classifier not available
        }
      }
    }
    // Last resort: edit-distance match on CRNN name fragment
    if (!statName && nameFragment) statName = postprocessStatLine(nameFragment);

    // ── Step 7: Value ensemble — pick best from old CRNN + NumericCRNN beam ──
    const ensembleValue = numericCandidates.length > 0
      ? pickBestValueWithBeam(oldValue, numericCandidates, statName)
      : oldValue;

    // Best NumericCRNN log-prob (higher = more confident)
    const numericConf = numericCandidates.length > 0 ? numericCandidates[0][1] : 0;

    // ── Step 8: Schema validation (comma-reposition, phantom-digit, etc.) ──
    const [validatedValue, validatedName] = validateStat(ensembleValue, statName);

    // Compose final line
    const text = validatedValue && validatedName
      ? `${validatedValue} ${validatedName}`
      : validatedName || postprocessStatLine(rawText);
    if (text) {
      lines.push({
        text,
        value: validatedValue || oldValue,
        statName: validatedName || statName,
        labelConfidence: labelConf,
        numericConfidence: numericConf,
      });
    }
  }

  return lines;
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

  // Single-card without pre-refinement: previously returned [] because the
  // Kuva animation confused the model.  With violet color segmentation in
  // recognizeRivenCrop, the domain gap is bridged and CRNN can handle both
  // single-card and multipanel crops.

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
