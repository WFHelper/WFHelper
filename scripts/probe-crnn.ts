#!/usr/bin/env npx tsx
/**
 * Quick probe: test CRNN on manually cropped single-line regions from failure_1.PNG
 * to verify if the model can recognize individual stat lines.
 */
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd());
const modelPath = join(ROOT, "scripts", "train-paddleocr", "output", "riven_rec.onnx");
const vocabPath = join(ROOT, "scripts", "train-paddleocr", "output", "riven_rec_vocab.json");

async function main() {
const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
const { vocab, blank_idx } = JSON.parse(readFileSync(vocabPath, "utf8")) as {
  vocab: string[];
  blank_idx: number;
};
console.log(`Model loaded. vocab=${vocab.length} blank=${blank_idx}`);

async function recognize(pngBuffer: Buffer): Promise<{ text: string; debug: string }> {
  const { data, info } = await sharp(pngBuffer)
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const f32 = new Float32Array(W * 32);
  for (let i = 0; i < data.length; i++) f32[i] = data[i] / 127.5 - 1.0;
  let sumPx = 0; let maxPx = 0;
  for (let i = 0; i < f32.length; i++) { sumPx += f32[i]; if (f32[i] > maxPx) maxPx = f32[i]; }
  const meanPx = sumPx / f32.length;
  const tensor = new ort.Tensor("float32", f32, [1, 1, 32, W]);
  const out = await session.run({ image: tensor });
  const outputNames = Object.keys(out);
  const logitKey = outputNames[0];
  const logProbs = out[logitKey].data as Float32Array;
  const [T, , C] = out[logitKey].dims;
  let blankCount = 0; const topSeq: string[] = [];
  let prev = -1;
  const chars: string[] = [];
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bScore = logProbs[t * C];
    for (let c = 1; c < C; c++) {
      const v = logProbs[t * C + c];
      if (v > bScore) { bScore = v; best = c; }
    }
    if (best === blank_idx) blankCount++;
    else topSeq.push(vocab[best] ?? `?${best}`);
    if (best !== blank_idx && best !== prev) chars.push(vocab[best] ?? "");
    prev = best;
  }
  const debug = `W=${W} T=${T} C=${C} key=${logitKey} meanPx=${meanPx.toFixed(3)} maxPx=${maxPx.toFixed(3)} blank=${blankCount}/${T} nonBlankSeq=[${topSeq.join("")}]`;
  return { text: chars.join(""), debug };
}

// From visual analysis of failure_1.PNG (1920x1080):
// The riven card text area (dark bg with white stats) is at approximately:
// x=830 to x=1100, y=700 to y=860 (270px wide, 160px tall, 6 text lines ~22px each)
// Text lines (using tight crops of just each line area):
const lineCoords = [
  { name: "weapon_name", left: 830, top: 700, width: 265, height: 22 },
  { name: "stat_1____", left: 830, top: 722, width: 265, height: 22 },
  { name: "stat_2____", left: 830, top: 744, width: 265, height: 22 },
  { name: "stat_3____", left: 830, top: 766, width: 265, height: 22 },
  { name: "stat_4____", left: 830, top: 788, width: 265, height: 22 },
];

// Ground truth for failure_1.PNG
const groundTruth = [
  "Burston Vexi-decican",
  "+126,2% Status Duration",
  "+122,2% Electricity",
  "+112% Multishot",
  "x0,58 Damage to Grineer",
];

console.log("\n=== Probing individual line crops from failure_1.PNG ===");
for (let i = 0; i < lineCoords.length; i++) {
  const c = lineCoords[i];
  const pngBuf = await sharp("OCR-debug/riven_images/failure_1.PNG")
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .png()
    .toBuffer();
  await sharp(pngBuf).toFile(`temp_probe_line${i + 1}.png`);
  const { text: result, debug } = await recognize(pngBuf);
  const gt = groundTruth[i] ?? "(none)";
  const match = result.toLowerCase().includes(gt.substring(0, 6).toLowerCase());
  console.log(`  line${i + 1} [${c.name}]:`);
  console.log(`    CRNN: "${result}" (${match ? "MATCH" : "MISMATCH"})`);
  console.log(`    GT:   "${gt}"`);
  console.log(`    dbg:  ${debug}`);
}

// Also test a synthetic image (dark bg + white text from training distribution)
console.log("\n=== Synthetic test (should be recognized) ===");
const { createCanvas } = await import("canvas" as string).catch(() => ({ createCanvas: null })) as { createCanvas: ((w: number, h: number) => any) | null };
if (createCanvas) {
  const canvas = createCanvas(320, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(15,10,20)";
  ctx.fillRect(0, 0, 320, 32);
  ctx.fillStyle = "white";
  ctx.font = "22px monospace";
  ctx.fillText("+112% Multishot", 5, 26);
  const buf = canvas.toBuffer("image/png");
  const { text, debug } = await recognize(buf);
  console.log(`  synthetic "+112% Multishot": "${text}"`);
  console.log(`  dbg: ${debug}`);
} else {
  console.log("  (canvas not available, skipping synthetic test)");
}

// Also do a grayscale inversion test (in case model was trained with inverted polarity)
console.log("\n=== Contrast stretch test (normalize luma range to [0,1]) ===");
for (let i = 0; i < 3; i++) {
  const c = lineCoords[i];
  const rawBuf = await sharp("OCR-debug/riven_images/failure_1.PNG")
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .png()
    .toBuffer();

  // Build a grayscale-then-normalize version
  const { data, info } = await sharp(rawBuf)
    .resize({ height: 32, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const f32 = new Float32Array(W * 32);
  let maxVal = 0;
  for (let j = 0; j < data.length; j++) { const v = data[j] / 127.5 - 1.0; f32[j] = v; if (v > maxVal) maxVal = v; }
  // Stretch: divide by maxVal so brightest pixel = 1.0
  if (maxVal > 0.05) for (let j = 0; j < f32.length; j++) f32[j] /= maxVal;

  const tensor = new ort.Tensor("float32", f32, [1, 1, 32, W]);
  const out = await session.run({ image: tensor });
  const logKey = Object.keys(out)[0];
  const logPs = out[logKey].data as Float32Array;
  const [T, , C] = out[logKey].dims;
  let prev = -1; const chars: string[] = [];
  for (let t = 0; t < T; t++) {
    let best = 0, bScore = logPs[t * C];
    for (let cc = 1; cc < C; cc++) { const v = logPs[t * C + cc]; if (v > bScore) { bScore = v; best = cc; } }
    if (best !== blank_idx && best !== prev) chars.push(vocab[best] ?? "");
    prev = best;
  }
  const result = chars.join("");
  const gt = groundTruth[i] ?? "(none)";
  console.log(`  line${i + 1} stretched(maxVal=${maxVal.toFixed(3)}): "${result}" (GT: "${gt}")`);
}

// Test with sharp's builtin normalize (stretches per-channel before grayscale)
console.log("\n=== Bright-threshold binarize (text=WHITE, bg=BLACK) then CRNN ===");
// In production, 'bright-150+dilate' creates BLACK text on WHITE bg (for WinRT/Tesseract)
// For CRNN we want the OPPOSITE: WHITE text on BLACK bg (matching training data)
// So we binarize: max(R,G,B) >= threshold → pixel=255 (text=bright), else 0 (bg=dark)
for (let threshold of [150, 120, 100, 80]) {
  for (let i = 0; i < 3; i++) {
    const c = lineCoords[i];
    const { data: rawRgba, info: rawInfo } = await sharp("OCR-debug/riven_images/failure_1.PNG")
      .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
      .resize({ height: 64, fit: "contain", background: { r: 0, g: 0, b: 0 } })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Binarize: max channel >= threshold → 255 (text), else 0 (bg)
    const binaryGray = Buffer.alloc(rawInfo.width * rawInfo.height);
    const channels = rawInfo.channels;
    for (let px = 0; px < rawInfo.width * rawInfo.height; px++) {
      const r = rawRgba[px * channels];
      const g = rawRgba[px * channels + 1];
      const b = rawRgba[px * channels + 2];
      binaryGray[px] = (Math.max(r, g, b) >= threshold) ? 255 : 0;
    }
    // Save for first threshold+line combo
    if (threshold === 150 && i === 0) {
      await sharp(binaryGray, { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } })
        .png().toFile("temp_binary_150.png");
    }
    // Resize to H=32 and run CRNN
    const grayPng = await sharp(binaryGray, { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } })
      .png().toBuffer();
    const { text: result } = await recognize(grayPng);
    const gt = groundTruth[i] ?? "(none)";
    if (i === 0 || result !== "") {
      console.log(`  thr=${threshold} line${i + 1}: "${result}" (GT: "${gt}")`);
    }
  }
}

console.log("\nDone.");
}

main().catch(console.error);