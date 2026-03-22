#!/usr/bin/env npx tsx
/**
 * Riven OCR benchmark — ONNX CRNN vs PaddleOCR server
 *
 * Measures two OCR paths on the 8 debug images in OCR-debug/riven_images/:
 *
 *   PaddleOCR (before):  Python subprocess, PP-OCRv4 detect+recognize
 *                         ~30s startup, ~120-200ms/image steady-state
 *
 *   ONNX CRNN (after):   Pure Node.js, geometry-based stats crop → 4 horizontal
 *                         strips → custom-trained CRNN recognizer
 *                         ~100ms model load, ~5ms/strip × N strips
 *
 * Usage:
 *   npx tsx scripts/benchmark-riven-onnx.ts               # Both sections
 *   npx tsx scripts/benchmark-riven-onnx.ts --skip-paddle # ONNX only (faster)
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  parseRivenStats,
  splitRivenStructuredText,
  scoreStatsCandidate,
  preprocessOcrText,
  type RivenStat,
} from "../ipc/overlay/rivenScanText.js";

// ── Constants matching production ────────────────────────────────────────────

const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };
const ROLL_CARD_CROP = { x: 0.411, y: 0.416, width: 0.177, height: 0.434 };
const MIN_ACCEPTABLE_RIVEN_STATS = 2;
const MIN_OCR_WIDTH = 1800;

// Approx card-frame + deriveRivenRegions fractions (without Sobel, matches production geometry):
// Card frame within rough crop: left=8%, top=34%, width=84%, height=50%
// Stats region (deriveRivenRegions expansion):
//   left  = 8% - 4%*84%  ≈ 4.6% of rough W
//   top   = 34% - 2%*50% ≈ 33% of rough H
//   width = 84% * 1.08   ≈ 90.7% of rough W
//   height = min(50%*1.84, 100%-33%) = min(92%, 67%) = 67% of rough H
const APPROX_STATS = {
  leftFrac: 0.046,
  topFrac: 0.33,
  widthFrac: 0.907,
  heightFrac: 0.67,
};

// ── Image helpers (sharp-based, no Electron) ──────────────────────────────────

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

async function loadImage(filePath: string): Promise<RawImage> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cropRgba(
  img: RawImage,
  rect: { x: number; y: number; width: number; height: number },
): RawImage {
  const cx = Math.max(0, Math.floor(img.width * rect.x));
  const cy = Math.max(0, Math.floor(img.height * rect.y));
  const cw = Math.max(1, Math.min(Math.floor(img.width * rect.width), img.width - cx));
  const ch = Math.max(1, Math.min(Math.floor(img.height * rect.height), img.height - cy));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcRow = Math.min(cy + row, img.height - 1);
    const srcOff = (srcRow * img.width + cx) * 4;
    const dstOff = row * cw * 4;
    const copyLen = Math.min(cw * 4, img.data.length - srcOff);
    if (copyLen > 0) img.data.copy(out, dstOff, srcOff, srcOff + copyLen);
  }
  return { data: out, width: cw, height: ch };
}

function extractSubregion(
  img: RawImage,
  leftFrac: number,
  topFrac: number,
  widthFrac: number,
  heightFrac: number,
): RawImage {
  const x = Math.max(0, Math.floor(img.width * leftFrac));
  const y = Math.max(0, Math.floor(img.height * topFrac));
  const w = Math.max(1, Math.min(Math.floor(img.width * widthFrac), img.width - x));
  const h = Math.max(1, Math.min(Math.floor(img.height * heightFrac), img.height - y));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * img.width + x) * 4;
    const dstOff = row * w * 4;
    const copyLen = Math.min(w * 4, img.data.length - srcOff);
    if (copyLen > 0) img.data.copy(out, dstOff, srcOff, srcOff + copyLen);
  }
  return { data: out, width: w, height: h };
}

async function rawToPng(img: RawImage): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toBuffer();
}

// Apply bright-150+dilate enhancement (matches production enhanceForRivenOcr).
// PaddleOCR receives this enhanced image in the primary strategy pass.
async function enhanceBright(img: RawImage, threshold: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = img;
  const scale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const sw = Math.min(6000, width * scale);
  const sh = Math.min(6000, height * scale);
  const rawBuf = await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(sw, sh, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const pixelCount = sw * sh;
  const mask = Buffer.alloc(pixelCount);
  for (let bi = 0, pi = 0; bi < rawBuf.length; bi += 4, pi++) {
    const maxC = Math.max(rawBuf[bi], rawBuf[bi + 1], rawBuf[bi + 2]);
    mask[pi] = maxC >= threshold ? 1 : 0;
  }

  // Dilate 1px
  const output = Buffer.alloc(pixelCount);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < sw && ny >= 0 && ny < sh && mask[ny * sw + nx]) found = true;
        }
      }
      output[y * sw + x] = found ? 0 : 255;
    }
  }

  return sharp(output, { raw: { width: sw, height: sh, channels: 1 } }).png().toBuffer();
}

/**
 * Detect the riven card's dark inner text area using row-mean luminance analysis.
 *
 * The riven card has a dark (near-black or at most dim) interior against a much
 * brighter animated background.  We find the first significant drop in row mean
 * luma (bright→dark transition = card top edge) and the last dark row (card bottom
 * edge, typically before the all-black letterbox strip at 90%+ of card-crop height).
 *
 * This approach is robust to animated Kuva portal backgrounds because the
 * background rows have uniformly HIGH mean luma (≥50) while the card interior
 * rows have consistently LOW mean luma (<40).
 *
 * Uses RGBA channel order (from sharp .ensureAlpha().raw()).
 */
function findDarkCardInterior(
  img: RawImage,
): { left: number; top: number; width: number; height: number } | null {
  const H = img.height;
  const W = img.width;

  // Compute mean luma for each row (sample every 4 pixels for speed)
  const rowMean = new Float32Array(H);
  const stepX = Math.max(1, Math.floor(W / 120));
  const sampleCount = Math.floor(W / stepX);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = 0; x < W; x += stepX) {
      const idx = (y * W + x) * 4;
      sum += 0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2];
    }
    rowMean[y] = sum / sampleCount;
  }

  // Smooth with a 3-row moving average to reduce noise
  const smooth = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    smooth[y] = (rowMean[Math.max(0, y - 1)] + rowMean[y] + rowMean[Math.min(H - 1, y + 1)]) / 3;
  }

  // The card interior has mean luma < DARK_THRESH.
  // Background typically has mean > BRIGHT_THRESH.
  const DARK_THRESH = 45;  // row is "dark" (part of card interior) if mean < 45
  const MIN_DARK_ROWS = Math.floor(H * 0.12);  // card interior must span ≥12% of height

  let darkStart = -1, darkEnd = -1;
  // Find the longest contiguous run of dark rows
  let runStart = -1, bestStart = -1, bestLen = 0;
  for (let y = 0; y <= H; y++) {
    const dark = y < H && smooth[y] < DARK_THRESH;
    if (dark) {
      if (runStart < 0) runStart = y;
    } else {
      if (runStart >= 0) {
        const len = y - runStart;
        if (len > bestLen) {
          bestLen = len;
          bestStart = runStart;
        }
        runStart = -1;
      }
    }
  }

  if (bestLen < MIN_DARK_ROWS) return null;
  darkStart = bestStart;
  darkEnd = bestStart + bestLen;

  // Vertical extent is the dark zone. Use the full card width (the card spans the full
  // width of the crop region — we don't need to shrink horizontally).
  const top = Math.max(0, darkStart);
  const bottom = Math.min(H, darkEnd);
  const h = bottom - top;
  if (h < H * 0.12) return null;

  return { left: 0, top, width: W, height: h };
}

// ── Ground truth ─────────────────────────────────────────────────────────────

const GROUND_TRUTH: Record<
  string,
  Array<{ name: string; value: number | null; positive: boolean; multiplier?: boolean }>
> = {
  "success_1.PNG": [
    { name: "Critical Chance for Slide Attack", value: 128.1, positive: true },
    { name: "Melee Damage", value: 157, positive: true },
    { name: "Heat", value: 98.8, positive: true },
    { name: "Critical Chance", value: 147.6, positive: false },
  ],
  "success_2.PNG": [
    { name: "Melee Damage", value: 189.5, positive: true },
    { name: "Status Chance", value: 120.4, positive: true },
    { name: "Attack Speed", value: 69.7, positive: true },
    { name: "Finisher Damage", value: 106.5, positive: false },
  ],
  "failure_1.PNG": [
    { name: "Status Duration", value: 126.2, positive: true },
    { name: "Electricity", value: 122.2, positive: true },
    { name: "Multishot", value: 112, positive: true },
    { name: "Damage to Grineer", value: 0.58, positive: false, multiplier: true },
  ],
  "failure_2.PNG": [
    { name: "Range", value: 2.5, positive: true },
    { name: "Attack Speed", value: 70.6, positive: true },
    { name: "Impact", value: 151.4, positive: true },
    { name: "Combo Duration", value: 8.6, positive: false },
  ],
  "failure_3.PNG": [
    { name: "Puncture", value: 115.1, positive: true },
    { name: "Heat", value: 94.8, positive: true },
    { name: "Reload Speed", value: 52.3, positive: true },
  ],
  "failure_4.PNG": [
    { name: "Damage to Corpus", value: 1.3, positive: true, multiplier: true },
    { name: "Damage to Grineer", value: 1.36, positive: true, multiplier: true },
    { name: "Heat", value: 62.2, positive: true },
    { name: "Impact", value: 68.4, positive: false },
  ],
  "success_multipanel_1.PNG": [
    { name: "Critical Damage", value: 165.5, positive: true },
    { name: "Weapon Recoil", value: 115.9, positive: false },
  ],
  "success_multipanel_2.PNG": [
    { name: "Ammo Maximum", value: 67.9, positive: true },
    { name: "Status Chance", value: 115.9, positive: true },
  ],
};

function scoreAccuracy(
  stats: RivenStat[],
  expected: (typeof GROUND_TRUTH)[string],
): { namesMatched: number; valuesMatched: number; totalExpected: number; details: string[] } {
  const details: string[] = [];
  let namesMatched = 0;
  let valuesMatched = 0;
  for (const exp of expected) {
    const found = stats.find((s) => s.name.toLowerCase() === exp.name.toLowerCase());
    if (found) {
      namesMatched++;
      if (exp.value === null) {
        if (found.value !== null) {
          valuesMatched++;
          details.push(`  ✓ ${exp.name}: x${found.value}`);
        } else {
          details.push(`  ~ ${exp.name}: name matched but value missing`);
        }
      } else if (found.value !== null && Math.abs(found.value - exp.value) < 3) {
        valuesMatched++;
        details.push(
          `  ✓ ${exp.name}: ${found.positive ? "+" : "-"}${found.value} (exp ${exp.value})`,
        );
      } else {
        details.push(
          `  ✗ ${exp.name}: value ${found.value ?? "null"} (exp ${exp.value})`,
        );
      }
    } else {
      details.push(`  ✗ ${exp.name}: NOT FOUND`);
    }
  }
  for (const s of stats) {
    if (!expected.some((e) => e.name.toLowerCase() === s.name.toLowerCase())) {
      details.push(`  ? ${s.name}: extra stat`);
    }
  }
  return { namesMatched, valuesMatched, totalExpected: expected.length, details };
}

function formatStats(stats: RivenStat[]): string {
  if (!stats.length) return "(none)";
  return stats
    .map((s) => {
      const v = s.value === null ? "?" : s.multiplier ? `x${s.value}` : `${s.value}%`;
      return `${s.positive ? "+" : "-"}${v} ${s.name}`;
    })
    .join(", ");
}

// ── PaddleOCR standalone client ───────────────────────────────────────────────

function resolvePython(): string {
  const envOverride = process.env["WF_PYTHON_EXE"];
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  const wellKnown =
    "C:\\Users\\User\\AppData\\Local\\Programs\\Python\\Python39\\python.exe";
  if (fs.existsSync(wellKnown)) return wellKnown;
  return "python";
}

function resolvePaddleScript(): string {
  const candidates = [
    path.join(process.cwd(), "scripts", "paddle-ocr-server.py"),
    path.join(__dirname, "paddle-ocr-server.py"),
    path.join(__dirname, "..", "scripts", "paddle-ocr-server.py"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

interface PaddleResult {
  ok: boolean;
  result?: {
    text: string;
    lines: Array<{
      text: string;
      box: { left: number; top: number; width: number; height: number };
      words: Array<{ text: string; box: { left: number; top: number; width: number; height: number } }>;
    }>;
  };
  error?: string;
}

class BenchmarkPaddleClient {
  private proc?: ChildProcess;
  startupMs = 0;
  private readyResolve?: () => void;
  private readyPromise: Promise<void>;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (r: PaddleResult) => void; reject: (e: Error) => void }
  >();
  private seq = 0;

  constructor() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  async start(timeoutMs = 90_000): Promise<void> {
    const python = resolvePython();
    const script = resolvePaddleScript();
    const t0 = Date.now();

    this.proc = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });

    const timeoutErr = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`PaddleOCR server startup timed out (${timeoutMs}ms)`)), timeoutMs),
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line === "===PADDLE_OCR_SERVER_READY===") {
          this.startupMs = Date.now() - t0;
          this.readyResolve?.();
          continue;
        }
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as PaddleResult & { id?: string };
          const id = msg.id ?? "";
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            entry.resolve(msg);
          }
        } catch {
          // ignore non-JSON lines (e.g. paddle log messages)
        }
      }
    });

    this.proc.stderr!.on("data", (_chunk: Buffer) => {
      // paddle logs go to stderr — ignore in benchmark
    });

    this.proc.on("error", (err: Error) => {
      for (const e of this.pending.values()) e.reject(err);
      this.pending.clear();
    });

    await Promise.race([this.readyPromise, timeoutErr]);
  }

  async recognize(pngBuffer: Buffer, timeoutMs = 15_000): Promise<PaddleResult> {
    const id = `req_${++this.seq}`;
    return new Promise<PaddleResult>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PaddleOCR request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });

      const payload = JSON.stringify({ id, imageBase64: pngBuffer.toString("base64") }) + "\n";
      this.proc!.stdin!.write(payload);
    });
  }

  stop(): void {
    try {
      this.proc?.stdin?.end();
      this.proc?.kill("SIGTERM");
    } catch { /* ignore */ }
  }
}

// ── ONNX standalone runner ────────────────────────────────────────────────────

function resolveOnnxModel(): string {
  const candidates = [
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "riven_rec.onnx"),
    path.join(__dirname, "train-paddleocr", "output", "riven_rec.onnx"),
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "riven_rec.onnx"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function resolveVocabJson(): string {
  const candidates = [
    path.join(process.cwd(), "scripts", "train-paddleocr", "output", "riven_rec_vocab.json"),
    path.join(__dirname, "train-paddleocr", "output", "riven_rec_vocab.json"),
    path.join(__dirname, "..", "scripts", "train-paddleocr", "output", "riven_rec_vocab.json"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _onnxSession: any = null;
let _onnxVocab: string[] = [];
let _onnxBlank = 70;
let _onnxModelMs = 0;

async function loadOnnxModel(): Promise<void> {
  const modelPath = resolveOnnxModel();
  const vocabPath = resolveVocabJson();

  if (!fs.existsSync(modelPath)) {
    throw new Error(`ONNX model not found at ${modelPath}`);
  }

  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const ort: any = require("onnxruntime-node");
  _onnxSession = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
  });
  _onnxModelMs = Date.now() - t0;

  if (fs.existsSync(vocabPath)) {
    const data = JSON.parse(fs.readFileSync(vocabPath, "utf8")) as {
      vocab: string[];
      blank_idx: number;
    };
    _onnxVocab = data.vocab;
    _onnxBlank = data.blank_idx;
  }
}

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
    if (best !== _onnxBlank && best !== prev) {
      chars.push(_onnxVocab[best] ?? "");
    }
    prev = best;
  }
  return chars.join("");
}

async function recognizeCrop(pngBuffer: Buffer): Promise<string> {
  if (!_onnxSession) throw new Error("ONNX session not loaded");

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sharp: any = require("sharp");
  const { data, info } = await sharp(pngBuffer)
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const float32 = new Float32Array(W * 32);
  for (let i = 0; i < (data as Buffer).length; i++) {
    float32[i] = (data as Buffer)[i] / 127.5 - 1.0;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const ort: any = require("onnxruntime-node");
  const tensor = new ort.Tensor("float32", float32, [1, 1, 32, W]);
  const output = await _onnxSession.run({ image: tensor });

  const logProbs: Float32Array = output["log_probs"]?.data ?? output["logits"]?.data;
  const [T, , C] = (output["log_probs"]?.dims ?? output["logits"]?.dims ?? [0, 1, 1]) as number[];
  return greedyCtcDecode(logProbs, T, C);
}

// ── Text-line row profiler ────────────────────────────────────────────────────

/**
 * Detect individual text-line regions within a card crop by measuring per-row
 * luminance standard deviation within a restricted x-column and y-range.
 *
 * Using variance instead of brightness density makes this robust to animated
 * Kuva portal backgrounds: sparse bright sparks give low SD (~10-20) while a
 * row with bright letters on a dark background gives high SD (~40-90).
 *
 * Returns y/height bounds in the INPUT image's coordinate space.
 */
async function detectTextLineRowsBinarized(
  img: RawImage,
  _thresholdUnused = 70,       // kept for API compat; SD_THRESH is hard-coded
  xStartFrac = 0.0,
  xEndFrac = 1.0,
  yStartPx = 0,
  yEndPx?: number,
): Promise<Array<{ y: number; height: number }>> {
  const sharp = (await import("sharp")).default;
  const H = img.height;
  const W = img.width;
  const yStart = Math.max(0, yStartPx);
  const yEnd   = Math.min(H, yEndPx ?? H);
  const regionH = Math.max(1, yEnd - yStart);

  const xStart = Math.max(0, Math.floor(W * xStartFrac));
  const xEnd   = Math.min(W, Math.ceil(W * xEndFrac));
  const colW   = Math.max(1, xEnd - xStart);

  // Scale the Y-restricted column to 800px for consistent row profiling.
  const targetH = 800;
  const scale = targetH / regionH;
  const scaledColW = Math.max(1, Math.round(colW * scale));

  const colBuf = await sharp(img.data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: xStart, top: yStart, width: colW, height: regionH })
    .resize(scaledColW, targetH, { kernel: "linear" })
    .raw()
    .toBuffer();

  // Per-row luminance standard deviation.
  // Text rows: bright letters on dark bg → high SD (~40-90).
  // Background rows (dark, animated sparks): low SD (~5-20).
  const rowSD = new Float32Array(targetH);
  for (let y = 0; y < targetH; y++) {
    let sum = 0;
    for (let x = 0; x < scaledColW; x++) {
      const i = (y * scaledColW + x) * 4;
      sum += 0.299 * colBuf[i] + 0.587 * colBuf[i + 1] + 0.114 * colBuf[i + 2];
    }
    const mean = sum / scaledColW;
    let sqDiff = 0;
    for (let x = 0; x < scaledColW; x++) {
      const i = (y * scaledColW + x) * 4;
      const luma = 0.299 * colBuf[i] + 0.587 * colBuf[i + 1] + 0.114 * colBuf[i + 2];
      const d = luma - mean;
      sqDiff += d * d;
    }
    rowSD[y] = Math.sqrt(sqDiff / scaledColW);
  }

  // A row is "text" when its SD exceeds this threshold.
  const SD_THRESH = 20;
  const gapTol   = Math.max(3, Math.floor(targetH * 0.015));
  const minLineH = Math.max(4, Math.floor(targetH * 0.015));
  const maxLineH = Math.floor(targetH * 0.30);   // wider: stat names can span many rows after 3× scale
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

// ── ONNX path: geometry + row-profile strips ──────────────────────────────────

/**
 * Simulate the production ONNX path without NativeImage:
 *  1. Take the rough card crop
 *  2. Scan the text column (x≈32-70%) to detect individual text line y-positions
 *     using a brightness+variance combined metric (text = bright isolated pixels)
 *  3. Generate bands at detected positions with known 22px pitch
 *  4. Feed each text-line crop to CRNN, resize to 32px height for model
 *  5. Parse combined recognized text
 *
 * Note: production code uses exact Sobel-based card detection (NativeImage).
 *       This is a Node.js fallback path for benchmarking purposes.
 */
async function runOnnxGridPath(
  cardCrop: RawImage,
  verbose = false,
  isMultipanel = false,
): Promise<{
  stats: RivenStat[];
  linesRecognized: string[];
  numStrips: number;
  enhanceLabel: string;
  debugNote: string;
  onnxMs: number;
}> {
  const sharp = (await import("sharp")).default;
  const t0 = Date.now();

  const H = cardCrop.height;
  const W = cardCrop.width;

  // Text column: probe-crnn confirms stat text is at x=38-63% in the single-card
  // crop. For multipanel, the narrower crop shifts text to x=12-90% of card width.
  const colStartFrac = isMultipanel ? 0.12 : 0.35;
  const colEndFrac   = isMultipanel ? 0.90 : 0.67;
  const TEXT_X_START = Math.floor(W * colStartFrac);
  const TEXT_X_END   = Math.min(W, Math.ceil(W * colEndFrac));

  // Line geometry constants — used only for the grid fallback path.
  const lineH_px = Math.max(12, Math.round(H * 0.045));
  const SCAN_AREA_TOP = Math.floor(H * 0.40);
  const SCAN_AREA_BOT = Math.min(H, Math.ceil(H * 0.82));

  // ── Step 1: Locate text-line rows via brightness profile ──────────────────
  // Restricting Y to the dark zone or fixed stats area is essential: card
  // headers/footers contain sparse bright pixels that look like text rows at
  // lower thresholds.
  const interior = findDarkCardInterior(cardCrop);
  const yMin = interior ? interior.top : SCAN_AREA_TOP;
  const yMax = interior ? (interior.top + interior.height) : SCAN_AREA_BOT;
  const detectedRows = await detectTextLineRowsBinarized(
    cardCrop, 70, colStartFrac, colEndFrac, yMin, yMax,
  );

  // Fall back to the 3-pass pitch grid only when row detection finds too few rows
  // (e.g. failure_2 has an animated background that saturates the brightness profile).
  let usedRects: Array<{ y: number; height: number }>;
  if (detectedRows.length >= 2) {
    usedRects = detectedRows;
  } else {
    usedRects = [];
    for (const off of [0, Math.round(lineH_px / 3), Math.round(2 * lineH_px / 3)]) {
      for (let y = SCAN_AREA_TOP + off; y + lineH_px <= SCAN_AREA_BOT; y += lineH_px) {
        usedRects.push({ y, height: lineH_px });
      }
    }
    usedRects.sort((a, b) => a.y - b.y);
  }

  const detected = detectedRows.length >= 2;
  const debugNote = interior
    ? `dark-zone top=${interior.top} h=${interior.height} | ${detected ? "row-detect" : "grid-fallback"} n=${usedRects.length}`
    : `no-dark-zone | ${detected ? "row-detect" : "grid-fallback"} n=${usedRects.length}`;

  if (verbose) {
    console.log(`    [geometry] ${debugNote}`);
  }

  const lines: string[] = [];

  for (const rect of usedRects) {
    const colLeft  = TEXT_X_START;
    const colRight = TEXT_X_END;
    const colW = colRight - colLeft;

    // Pass the raw strip to recognizeCrop — it resizes to height=32 internally.
    const stripPng = await sharp(cardCrop.data, {
      raw: { width: W, height: H, channels: 4 },
    })
      .extract({ left: colLeft, top: rect.y, width: colW, height: rect.height })
      .png()
      .toBuffer();

    const text = (await recognizeCrop(stripPng)).trim();
    if (verbose) {
      console.log(`    band${usedRects.indexOf(rect)+1} (y=${rect.y}, h=${rect.height}, x=${colLeft}-${colRight}): "${text}"`);
    }
    if (text) lines.push(text);
  }

  const combinedText = lines.join("\n");
  const stats = parseRivenStats(combinedText);
  const enhanceLabel = `${usedRects.length} rows @ ${W}×${H} (${detectedRows.length >= 2 ? "row-detect" : "grid-fallback"})`;

  const onnxMs = Date.now() - t0;
  return {
    stats,
    linesRecognized: lines,
    numStrips: usedRects.length,
    enhanceLabel,
    debugNote,
    onnxMs,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const skipPaddle = process.argv.includes("--skip-paddle");

(async () => {
  const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  console.log(`Riven OCR Benchmark — ONNX CRNN vs PaddleOCR  (${files.length} images)`);
  console.log(`Corpus: ${corpusDir}`);
  console.log("═".repeat(72));

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION A — ONNX CRNN (no Python process)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  SECTION A : ONNX CRNN (pure Node.js)                 ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const onnxModelPath = resolveOnnxModel();
  if (!fs.existsSync(onnxModelPath)) {
    console.error(`ERROR: ONNX model not found at ${onnxModelPath}`);
    console.error("Run: python scripts/train-paddleocr/train.py --gpu --epochs 150 to train first");
    process.exit(1);
  }

  console.log("Loading ONNX model...");
  await loadOnnxModel();
  console.log(`✓ ONNX model loaded in ${_onnxModelMs}ms  (vocab=${_onnxVocab.length} chars)\n`);

  let totalOnnxMs = 0;
  let totalOnnxNames = 0;
  let totalOnnxValues = 0;
  let totalOnnxExpected = 0;

  const onnxPerImage: Array<{
    file: string;
    onnxMs: number;
    stats: RivenStat[];
    numStrips: number;
  }> = [];

  for (const file of files) {
    const fullPath = path.join(corpusDir, file);
    const isMultipanel = /multipanel/i.test(file);
    const cropRect = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;

    console.log(`─── ${file} ───`);
    const img = await loadImage(fullPath);
    const cardCrop = cropRgba(img, cropRect);
    console.log(
      `  Card crop: ${cardCrop.width}×${cardCrop.height} (from ${img.width}×${img.height})`,
    );

    const result = await runOnnxGridPath(cardCrop, true, isMultipanel);
    onnxPerImage.push({ file, onnxMs: result.onnxMs, stats: result.stats, numStrips: result.numStrips });
    totalOnnxMs += result.onnxMs;

    console.log(`  ONNX (${result.numStrips} strips, ${result.enhanceLabel}): ${result.onnxMs}ms`);
    console.log(`  Parsed: ${formatStats(result.stats)}`);

    const gt = GROUND_TRUTH[file];
    if (gt) {
      const acc = scoreAccuracy(result.stats, gt);
      console.log(
        `  Accuracy: ${acc.namesMatched}/${acc.totalExpected} names, ${acc.valuesMatched}/${acc.totalExpected} values`,
      );
      for (const d of acc.details) console.log(`  ${d}`);
      totalOnnxNames += acc.namesMatched;
      totalOnnxValues += acc.valuesMatched;
      totalOnnxExpected += acc.totalExpected;
    }
    console.log();
  }

  console.log("ONNX summary:");
  console.log(`  Model load:   ${_onnxModelMs}ms`);
  console.log(`  Avg per image: ${Math.round(totalOnnxMs / files.length)}ms`);
  if (totalOnnxExpected > 0) {
    console.log(
      `  Accuracy: ${totalOnnxNames}/${totalOnnxExpected} names (${((totalOnnxNames / totalOnnxExpected) * 100).toFixed(0)}%), ` +
        `${totalOnnxValues}/${totalOnnxExpected} values (${((totalOnnxValues / totalOnnxExpected) * 100).toFixed(0)}%)`,
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECTION B — PaddleOCR server (Python subprocess)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  SECTION B : PaddleOCR server (Python subprocess)     ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  if (skipPaddle) {
    console.log("  [skipped — pass without --skip-paddle to include]\n");
  }

  let paddleStartupMs = 0;
  let totalPaddleMs = 0;
  let totalPaddleNames = 0;
  let totalPaddleValues = 0;
  let paddleExpected = 0;
  let paddleAvailable = false;

  const paddlePerImage: Array<{
    file: string;
    paddleMs: number;
    stats: RivenStat[];
  }> = [];

  if (!skipPaddle) {
    const client = new BenchmarkPaddleClient();
    try {
      console.log("Spawning paddle-ocr-server.py (this may take 30–60s for model load)...");
      await client.start(90_000);
      paddleStartupMs = client.startupMs;
      console.log(`✓ Server ready in ${paddleStartupMs}ms\n`);
      paddleAvailable = true;

      for (const file of files) {
        const fullPath = path.join(corpusDir, file);
        const isMultipanel = /multipanel/i.test(file);
        const cropRect = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;

        console.log(`─── ${file} ───`);
        const img = await loadImage(fullPath);
        const cardCrop = cropRgba(img, cropRect);

        // Use bright-150+dilate enhanced PNG (matches primary production strategy)
        let png: Buffer;
        try {
          png = await enhanceBright(cardCrop, 150);
        } catch {
          png = await rawToPng(cardCrop);
        }

        const t0 = Date.now();
        let paddleResult: PaddleResult;
        try {
          paddleResult = await client.recognize(png, 15_000);
        } catch (err) {
          console.log(`  ERROR: ${String(err)}`);
          paddlePerImage.push({ file, paddleMs: 15_000, stats: [] });
          continue;
        }
        const paddleMs = Date.now() - t0;
        totalPaddleMs += paddleMs;

        let stats: RivenStat[] = [];
        if (paddleResult.ok && paddleResult.result) {
          const split = splitRivenStructuredText(paddleResult.result);
          stats = parseRivenStats(split.statsText || paddleResult.result.text || "");
        }
        paddlePerImage.push({ file, paddleMs, stats });

        console.log(`  PaddleOCR: ${paddleMs}ms`);
        console.log(`  Parsed: ${formatStats(stats)}`);

        const gt = GROUND_TRUTH[file];
        if (gt) {
          const acc = scoreAccuracy(stats, gt);
          console.log(
            `  Accuracy: ${acc.namesMatched}/${acc.totalExpected} names, ${acc.valuesMatched}/${acc.totalExpected} values`,
          );
          for (const d of acc.details) console.log(`  ${d}`);
          totalPaddleNames += acc.namesMatched;
          totalPaddleValues += acc.valuesMatched;
          paddleExpected += acc.totalExpected;
        }
        console.log();
      }
    } catch (err) {
      console.error(`PaddleOCR server error: ${String(err)}`);
    } finally {
      client.stop();
    }

    if (paddleAvailable) {
      console.log("PaddleOCR summary:");
      console.log(`  Server startup:  ${paddleStartupMs}ms`);
      console.log(`  Avg per image:   ${Math.round(totalPaddleMs / files.length)}ms`);
      if (paddleExpected > 0) {
        console.log(
          `  Accuracy: ${totalPaddleNames}/${paddleExpected} names (${((totalPaddleNames / paddleExpected) * 100).toFixed(0)}%), ` +
            `${totalPaddleValues}/${paddleExpected} values (${((totalPaddleValues / paddleExpected) * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // COMPARISON TABLE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log("\n" + "═".repeat(72));
  console.log("COMPARISON SUMMARY");
  console.log("═".repeat(72));

  const onnxAvgMs = Math.round(totalOnnxMs / files.length);

  if (paddleAvailable) {
    const paddleAvgMs = Math.round(totalPaddleMs / files.length);
    const speedup = (paddleAvgMs / onnxAvgMs).toFixed(1);

    console.log(
      `\n${"Engine".padEnd(18)} ${"Startup".padStart(10)} ${"Avg/img".padStart(10)} ${"Names".padStart(8)} ${"Values".padStart(8)}`,
    );
    console.log("-".repeat(60));
    const paddleNamePct =
      paddleExpected > 0
        ? `${totalPaddleNames}/${paddleExpected} (${((totalPaddleNames / paddleExpected) * 100).toFixed(0)}%)`
        : "n/a";
    const paddleValPct =
      paddleExpected > 0
        ? `${totalPaddleValues}/${paddleExpected} (${((totalPaddleValues / paddleExpected) * 100).toFixed(0)}%)`
        : "n/a";
    const onnxNamePct =
      totalOnnxExpected > 0
        ? `${totalOnnxNames}/${totalOnnxExpected} (${((totalOnnxNames / totalOnnxExpected) * 100).toFixed(0)}%)`
        : "n/a";
    const onnxValPct =
      totalOnnxExpected > 0
        ? `${totalOnnxValues}/${totalOnnxExpected} (${((totalOnnxValues / totalOnnxExpected) * 100).toFixed(0)}%)`
        : "n/a";

    console.log(
      `${"PaddleOCR".padEnd(18)} ${(paddleStartupMs + "ms").padStart(10)} ${(paddleAvgMs + "ms").padStart(10)} ${paddleNamePct.padStart(8)} ${paddleValPct.padStart(8)}`,
    );
    console.log(
      `${"ONNX CRNN".padEnd(18)} ${(_onnxModelMs + "ms").padStart(10)} ${(onnxAvgMs + "ms").padStart(10)} ${onnxNamePct.padStart(8)} ${onnxValPct.padStart(8)}`,
    );
    console.log();
    console.log(`Speedup (per image): ${speedup}×  (${paddleAvgMs}ms → ${onnxAvgMs}ms)`);
    console.log(
      `Startup improvement: ${Math.round(paddleStartupMs / 1000)}s → ${_onnxModelMs}ms (${(paddleStartupMs / _onnxModelMs).toFixed(0)}× faster cold start)`,
    );
  } else {
    // ONNX only
    const onnxNamePct =
      totalOnnxExpected > 0
        ? `${totalOnnxNames}/${totalOnnxExpected} (${((totalOnnxNames / totalOnnxExpected) * 100).toFixed(0)}%)`
        : "n/a";
    const onnxValPct =
      totalOnnxExpected > 0
        ? `${totalOnnxValues}/${totalOnnxExpected} (${((totalOnnxValues / totalOnnxExpected) * 100).toFixed(0)}%)`
        : "n/a";

    console.log(`\nONNX CRNN:`);
    console.log(`  Model load: ${_onnxModelMs}ms`);
    console.log(`  Avg/image:  ${onnxAvgMs}ms`);
    console.log(`  Names:      ${onnxNamePct}`);
    console.log(`  Values:     ${onnxValPct}`);

    console.log("\nPer-image ONNX breakdown:");
    console.log(`  ${"File".padEnd(35)} ${"ms".padStart(6)} ${"Strips".padStart(6)} ${"Stats".padStart(20)}`);
    console.log("  " + "-".repeat(72));
    for (const r of onnxPerImage) {
      const statStr = formatStats(r.stats).slice(0, 40);
      console.log(
        `  ${r.file.padEnd(35)} ${String(r.onnxMs).padStart(6)} ${String(r.numStrips).padStart(6)} ${statStr}`,
      );
    }
  }

  console.log("\nDone.");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
