#!/usr/bin/env npx tsx
/**
 * Reward scanner benchmark — tests the REAL production pipeline against
 * corpus images in OCR-debug/reward_images/.
 *
 * Usage:
 *   npx tsx scripts/benchmark-reward-scanner.ts [--label <label>]
 *
 * Reports per-image speed (ms per phase) and accuracy (slot count vs ground truth,
 * items detected, strategy used, confidence).  Results are also appended to
 * OCR-debug/benchmark-results.txt for before/after comparisons.
 */

import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

// ─── Ground truth ──────────────────────────────────────────────────────────
// filename → expected slot count based on squad size implied by filename.
// Add entries as more images are added to the corpus.
const GROUND_TRUTH: Record<string, { slotCount: number }> = {
  "2_players.PNG": { slotCount: 2 },
  "3_players.PNG": { slotCount: 3 },
  "4_players.PNG": { slotCount: 4 },
};

// ─── Mock NativeImage ───────────────────────────────────────────────────────
// Pure-JS (synchronous) Electron NativeImage replacement backed by BGRA
// buffers with built-in CRC32 + PNG encoder so toPNG() stays synchronous.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crcB = Buffer.allocUnsafe(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crcB]);
}

function bgraToPng(bgra: Buffer, w: number, h: number): Buffer {
  const stride = w * 4;
  const raw = Buffer.allocUnsafe(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter = None
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = y * (stride + 1) + 1 + x * 4;
      raw[di] = bgra[si + 2]; // R
      raw[di + 1] = bgra[si + 1]; // G
      raw[di + 2] = bgra[si]; // B
      raw[di + 3] = bgra[si + 3]; // A
    }
  }
  const comp = zlib.deflateSync(raw, { level: 1 });
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", comp),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function cropBgra(src: Buffer, sw: number, x: number, y: number, w: number, h: number): Buffer {
  const out = Buffer.allocUnsafe(w * h * 4);
  for (let cy = 0; cy < h; cy++) {
    const si = ((y + cy) * sw + x) * 4;
    src.copy(out, cy * w * 4, si, si + w * 4);
  }
  return out;
}

function resizeBgraNearest(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(Math.floor((y * sh) / dh), sh - 1);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(Math.floor((x * sw) / dw), sw - 1);
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function makeMock(bgra: Buffer, w: number, h: number): any {
  return {
    getSize: () => ({ width: w, height: h }),
    toBitmap: () => bgra,
    toPNG: () => bgraToPng(bgra, w, h),
    isEmpty: () => false,
    crop(r: { x: number; y: number; width: number; height: number }) {
      const cx = Math.max(0, Math.min(r.x, w - 1));
      const cy = Math.max(0, Math.min(r.y, h - 1));
      const cw = Math.max(1, Math.min(r.width, w - cx));
      const ch = Math.max(1, Math.min(r.height, h - cy));
      return makeMock(cropBgra(bgra, w, cx, cy, cw, ch), cw, ch);
    },
    resize(opts: { width: number; height: number }) {
      const dw = Math.max(1, opts.width);
      const dh = Math.max(1, opts.height);
      return makeMock(resizeBgraNearest(bgra, w, h, dw, dh), dw, dh);
    },
  };
}

// ─── Electron module mock ───────────────────────────────────────────────────
// Injected before any scanner module is loaded so require("electron") returns
// our mock.  Must be done at module-evaluation time BEFORE the first use.
const ELECTRON_MOCK = {
  nativeImage: {
    createFromBitmap: (bitmap: Buffer, opts: { width: number; height: number }) =>
      makeMock(bitmap, opts.width, opts.height),
    createFromPath: (_p: string) => makeMock(Buffer.alloc(4), 1, 1),
    createEmpty: () => makeMock(Buffer.alloc(4), 1, 1),
  },
  app: { getPath: () => "" },
};

// Intercept require("electron") for all subsequent CJS loads
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeModule: any = require("node:module");
const _origLoad = NativeModule._load;
NativeModule._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "electron") return ELECTRON_MOCK;
  return _origLoad.call(this, request, parent, isMain);
};

// ─── Scanner imports (AFTER mock is registered) ────────────────────────────
// These use require() internally and will pick up our electron mock.
// We import the compiled CJS modules directly.
import { detectRewardSlotLayout } from "../services/rewardScannerImage.js";
import {
  setRelicItems,
  scanRewardsDetailed,
  getLastTriggerStats,
} from "../services/rewardScanner.js";

// ─── Item database for OCR accuracy testing ─────────────────────────────────
// Build a minimal set from @wfcd/items if available; otherwise use a static
// list of common prime rewards to still exercise the matching path.

function loadRelicItems(): Array<{ name: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Items = require("@wfcd/items");
    const all = new Items();
    const seen = new Map<string, { name: string }>();
    for (const item of all) {
      if (!item?.name) continue;
      const name: string = item.name;
      // Include relic rewards: Prime parts, Forma, void traces, common drops
      if (
        name.includes("Prime") ||
        name === "Forma Blueprint" ||
        name.includes("Relic") ||
        name === "Void Traces"
      ) {
        if (!seen.has(name)) seen.set(name, { name });
      }
    }
    // @wfcd/items is cosmetics-focused and misses many tradeable relic drops that ARE
    // in the production WFM catalog.  Supplement with the most common ones so the
    // benchmark DB is representative of what the production scanner actually uses.
    const supplemental = [
      // Consumables / universal drops
      "Forma Blueprint", "Exilus Adapter Blueprint", "Orokin Catalyst Blueprint", "Orokin Reactor Blueprint",
      // Narmer/Caliban era (missing from @wfcd/items component list)
      "Caliban Prime Blueprint", "Caliban Prime Neuroptics Blueprint",
      "Caliban Prime Chassis Blueprint", "Caliban Prime Systems Blueprint",
      // Nautilus sentinel
      "Nautilus Prime Blueprint", "Nautilus Prime Cerebrum Blueprint",
      "Nautilus Prime Carapace Blueprint", "Nautilus Prime Systems Blueprint",
      // Wukong (commonly in relics)
      "Wukong Prime Blueprint", "Wukong Prime Neuroptics Blueprint",
      "Wukong Prime Chassis Blueprint", "Wukong Prime Systems Blueprint",
      // Zephyr (commonly in relics)
      "Zephyr Prime Blueprint", "Zephyr Prime Neuroptics Blueprint",
      "Zephyr Prime Chassis Blueprint", "Zephyr Prime Systems Blueprint",
      // Epitaph (companion weapon)
      "Epitaph Prime Blueprint", "Epitaph Prime Receiver", "Epitaph Prime Stock", "Epitaph Prime Barrel",
      // Braton / Paris (common prime weapons)
      "Braton Prime Blueprint", "Braton Prime Barrel", "Braton Prime Receiver", "Braton Prime Stock",
      "Paris Prime Blueprint", "Paris Prime Limb", "Paris Prime String", "Paris Prime Upper Limb",
      "Trumna Prime Blueprint", "Trumna Prime Barrel", "Trumna Prime Receiver", "Trumna Prime Stock",
    ];
    for (const name of supplemental) {
      if (!seen.has(name)) seen.set(name, { name });
    }
    return [...seen.values()];
  } catch {
    // Static fallback — enough to exercise the matching path for typical 
    // Warframe prime reward screens
    return [
      "Volt Prime Blueprint", "Volt Prime Chassis Blueprint", "Volt Prime Neuroptics Blueprint", "Volt Prime Systems Blueprint",
      "Saryn Prime Blueprint", "Saryn Prime Chassis Blueprint", "Saryn Prime Neuroptics Blueprint", "Saryn Prime Systems Blueprint",
      "Mesa Prime Blueprint", "Mesa Prime Chassis Blueprint", "Mesa Prime Neuroptics Blueprint", "Mesa Prime Systems Blueprint",
      "Gauss Prime Blueprint", "Gauss Prime Neuroptics Blueprint", "Gauss Prime Systems Blueprint", "Gauss Prime Chassis Blueprint",
      "Ash Prime Blueprint", "Ash Prime Chassis Blueprint", "Ash Prime Neuroptics Blueprint", "Ash Prime Systems Blueprint",
      "Rhino Prime Blueprint", "Rhino Prime Chassis Blueprint", "Rhino Prime Neuroptics Blueprint", "Rhino Prime Systems Blueprint",
      "Trinity Prime Blueprint", "Trinity Prime Chassis Blueprint", "Trinity Prime Neuroptics Blueprint", "Trinity Prime Systems Blueprint",
      "Vauban Prime Blueprint", "Vauban Prime Chassis Blueprint", "Vauban Prime Neuroptics Blueprint", "Vauban Prime Systems Blueprint",
      "Tigris Prime Blueprint", "Tigris Prime Receiver", "Tigris Prime Stock", "Tigris Prime Barrel",
      "Nikana Prime Blueprint", "Nikana Prime Blade", "Nikana Prime Handle",
      "Braton Prime Blueprint", "Braton Prime Barrel", "Braton Prime Receiver", "Braton Prime Stock",
      "Paris Prime Blueprint", "Paris Prime Limb", "Paris Prime String", "Paris Prime Upper Limb",
      "Forma Blueprint",
      "Void Traces",
    ].map((name) => ({ name }));
  }
}

// ─── Image loading ──────────────────────────────────────────────────────────

async function loadAsMock(filePath: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require("sharp");
  const { data, info } = await sharp(filePath)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  // Convert RGBA → BGRA (Electron NativeImage format)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    data[i] = data[i + 2]; // B
    data[i + 2] = r; // R
  }
  return makeMock(data as Buffer, info.width, info.height);
}

// ─── Benchmark runner ───────────────────────────────────────────────────────

interface ImageBenchResult {
  file: string;
  expectedSlots: number;
  slotCount: number;
  slotConfidence: number;
  items: string[];
  itemCount: number;
  exactCount: number;
  strategy: string;
  totalMs: number;
  slotCorrect: boolean;
}

async function benchmarkImage(
  filePath: string,
  fileName: string,
  debugCrops = false,
): Promise<ImageBenchResult> {
  const expectedSlots = GROUND_TRUTH[fileName]?.slotCount ?? -1;

  const mockImage = await loadAsMock(filePath);

  // Phase A: standalone slot detection latency
  const slotDetectStart = Date.now();
  const layout = detectRewardSlotLayout(mockImage);
  const slotDetectMs = Date.now() - slotDetectStart;

  // Debug: save each slot's titleRect as a PNG for visual inspection
  if (debugCrops) {
    const { width: imgW, height: imgH } = mockImage.getSize();
    const cropDir = path.join(process.cwd(), "OCR-debug", "slot-crops");
    if (!fs.existsSync(cropDir)) fs.mkdirSync(cropDir, { recursive: true });
    const base = path.basename(fileName, path.extname(fileName));
    for (const slot of layout.slots) {
      const tr = slot.titleRect;
      const px = Math.round(tr.x * imgW);
      const py = Math.round(tr.y * imgH);
      const pw = Math.max(1, Math.round(tr.width * imgW));
      const ph = Math.max(1, Math.round(tr.height * imgH));
      const crop = mockImage.crop({ x: px, y: py, width: pw, height: ph });
      const pngBuf = crop.toPNG();
      const outPath = path.join(cropDir, `${base}_slot${slot.index}_title_${px}x${py}_${pw}x${ph}.png`);
      fs.writeFileSync(outPath, pngBuf);
    }
    console.log(`  [debug] Saved ${layout.slots.length} slot crops to ${cropDir}`);
  }

  // Phase B: full scan pipeline via F2 preCapture injection
  const preCapture = {
    image: mockImage,
    sourceType: "file" as const,
    sourceName: fileName,
    sourceId: fileName,
    sourceDisplayId: "bench",
  };
  const totalStart = Date.now();
  const result = await scanRewardsDetailed(preCapture);
  const totalMs = Date.now() - totalStart;
  const stats = getLastTriggerStats();

  const items = Array.isArray(result?.items) ? result.items.map((i: any) => i.name || "?") : [];
  const strategy = (result?.meta as any)?.strategy ?? stats?.strategy ?? "none";
  const slotConfidence = layout.confidence;
  const exactCount = (result?.meta as any)?.exactCount ?? 0;

  const slotCorrect = expectedSlots < 0 ? false : items.length === expectedSlots || layout.count === expectedSlots;

  console.log(`\n  ┌── ${fileName} ──`);
  console.log(`  │  Expected slots : ${expectedSlots < 0 ? "unknown" : expectedSlots}`);
  console.log(`  │  Slot detect    : ${slotDetectMs}ms -> ${layout.count} slots (conf ${slotConfidence.toFixed(3)})`);
  console.log(`  │  Full scan      : ${totalMs}ms  [captures=${stats?.captureCount ?? "?"} ocrCalls=${stats?.ocrCallCount ?? "?"} ocrMs=${stats?.ocrTotalMs ?? "?"}]`);
  console.log(`  │  Strategy       : ${strategy}`);
  console.log(`  │  Items found    : ${items.length}/${expectedSlots < 0 ? "?" : expectedSlots} (${exactCount} exact) ${slotCorrect ? "PASS" : "FAIL"}`);
  if (items.length > 0) console.log(`  │  Items          : ${items.join(" | ")}`);
  console.log(`  └──`);

  return {
    file: fileName,
    expectedSlots,
    slotCount: layout.count,
    slotConfidence,
    items,
    itemCount: items.length,
    exactCount,
    strategy,
    totalMs,
    slotCorrect,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const corpusDir = path.join(process.cwd(), "OCR-debug", "reward_images");
  const resultsPath = path.join(process.cwd(), "OCR-debug", "benchmark-results.txt");

  const args = process.argv.slice(2);
  const labelIdx = args.indexOf("--label");
  const label = labelIdx >= 0 ? (args[labelIdx + 1] || "unlabeled") : new Date().toISOString().slice(0, 19).replace("T", " ");
  const debugCrops = args.includes("--debug-crops");

  if (!fs.existsSync(corpusDir)) {
    console.error(`Corpus directory not found: ${corpusDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(corpusDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error("No images found in corpus directory");
    process.exit(1);
  }

  // Load item database
  const items = loadRelicItems();
  console.log(`\nLoaded ${items.length} relic items for OCR matching`);
  setRelicItems(items);

  console.log(`\n${"═".repeat(60)}`);
  console.log(` REWARD SCANNER BENCHMARK  —  ${label}`);
  console.log(` Corpus: ${files.length} image(s)  |  Items: ${items.length}`);
  console.log(`${"═".repeat(60)}`);

  const results: ImageBenchResult[] = [];
  const benchStart = Date.now();

  for (const file of files) {
    const filePath = path.join(corpusDir, file);
    try {
      const r = await benchmarkImage(filePath, file, debugCrops);
      results.push(r);
    } catch (err) {
      console.error(`  ERROR processing ${file}:`, (err as Error).message);
    }
  }

  const totalBenchMs = Date.now() - benchStart;

  // ── Summary ────────────────────────────────────────────────────────────
  const knownCount = results.filter((r) => r.expectedSlots >= 0).length;
  const correctSlotCount = results.filter((r) => r.slotCorrect).length;
  const totalItems = results.reduce((s, r) => s + r.itemCount, 0);
  const totalExpected = results.reduce((s, r) => s + Math.max(0, r.expectedSlots), 0);
  const meanMs = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.totalMs, 0) / results.length)
    : 0;
  const maxMs = results.length > 0 ? Math.max(...results.map((r) => r.totalMs)) : 0;
  const minMs = results.length > 0 ? Math.min(...results.map((r) => r.totalMs)) : 0;
  const slotAccuracy = knownCount > 0 ? Math.round((correctSlotCount / knownCount) * 100) : -1;
  const itemAccuracy = totalExpected > 0 ? Math.round((totalItems / totalExpected) * 100) : -1;

  const strategies = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.strategy] = (acc[r.strategy] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n${"═".repeat(60)}`);
  console.log(` SUMMARY`);
  console.log(`${"═".repeat(60)}`);
  console.log(` Images tested        : ${results.length}`);
  console.log(` Slot accuracy        : ${correctSlotCount}/${knownCount} (${slotAccuracy >= 0 ? slotAccuracy + "%" : "n/a"})`);
  console.log(` Item fill rate       : ${totalItems}/${totalExpected} (${itemAccuracy >= 0 ? itemAccuracy + "%" : "n/a"})`);
  console.log(` Mean scan latency    : ${meanMs}ms`);
  console.log(` Min / Max latency    : ${minMs}ms / ${maxMs}ms`);
  console.log(` Total bench time     : ${totalBenchMs}ms`);
  console.log(` Strategies used      : ${Object.entries(strategies).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Append to results file ──────────────────────────────────────────────
  const lines: string[] = [
    `\n${"─".repeat(60)}`,
    `BENCHMARK LABEL : ${label}`,
    `TIMESTAMP       : ${new Date().toISOString()}`,
    `IMAGES          : ${results.length}`,
    `SLOT ACCURACY   : ${correctSlotCount}/${knownCount} (${slotAccuracy >= 0 ? slotAccuracy + "%" : "n/a"})`,
    `ITEM FILL RATE  : ${totalItems}/${totalExpected} (${itemAccuracy >= 0 ? itemAccuracy + "%" : "n/a"})`,
    `MEAN LATENCY    : ${meanMs}ms`,
    `MIN/MAX LATENCY : ${minMs}ms / ${maxMs}ms`,
    `STRATEGIES      : ${Object.entries(strategies).map(([k, v]) => `${k}×${v}`).join(", ")}`,
    `PER IMAGE:`,
    ...results.map(
      (r) =>
        `  ${r.file.padEnd(20)} slots=${r.slotCount}/${r.expectedSlots >= 0 ? r.expectedSlots : "?"} ` +
        `items=${r.itemCount} exact=${r.exactCount} ${r.totalMs}ms [${r.strategy}] ${r.slotCorrect ? "PASS" : "FAIL"} ` +
        `| ${r.items.slice(0, 2).join(" | ")}${r.items.length > 2 ? " ..." : ""}`,
    ),
    `${"─".repeat(60)}`,
  ];

  fs.appendFileSync(resultsPath, lines.join("\n") + "\n", "utf8");
  console.log(`Results appended to ${resultsPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
