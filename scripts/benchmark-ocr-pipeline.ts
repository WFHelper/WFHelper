#!/usr/bin/env npx tsx
/**
 * OCR Pipeline Benchmark
 *
 * Runs the PRODUCTION OCR engines (native WinRT, PowerShell pool, Tesseract)
 * and the production matching/parsing pipeline on all corpus images from
 * OCR-debug/reward_images/, OCR-debug/riven_images/, and
 * OCR-debug/relic_selection/.
 *
 * Measures: raw OCR text, matched items, confidence, timing per engine.
 *
 * Usage:
 *   npx tsx scripts/benchmark-ocr-pipeline.ts
 *   npx tsx scripts/benchmark-ocr-pipeline.ts --rewards-only
 *   npx tsx scripts/benchmark-ocr-pipeline.ts --rivens-only
 *   npx tsx scripts/benchmark-ocr-pipeline.ts --relic-only
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const REWARD_CORPUS = path.join(process.cwd(), "OCR-debug", "reward_images");
const RIVEN_CORPUS = path.join(process.cwd(), "OCR-debug", "riven_images");
const RELIC_CORPUS = path.join(process.cwd(), "OCR-debug", "relic_selection");
const OUTPUT_FILE = path.join(process.cwd(), "OCR-debug", "benchmark-results.txt");
const __scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
const OCR_SCRIPT = path.join(__scriptDir, "ocr.ps1");

// ── Image helpers ───────────────────────────────────────────────────────────

interface ImageInfo {
  width: number;
  height: number;
  data: Buffer;
  channels: 4;
}

async function loadImage(filePath: string): Promise<ImageInfo> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(filePath).metadata();
  const rawBuf = await sharp(filePath).raw().ensureAlpha().toBuffer();
  return { width: meta.width!, height: meta.height!, data: rawBuf, channels: 4 };
}

async function savePng(filePath: string, img: ImageInfo): Promise<void> {
  const sharp = (await import("sharp")).default;
  await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .png()
    .toFile(filePath);
}

function cropImage(
  img: ImageInfo,
  rect: { x: number; y: number; width: number; height: number },
): ImageInfo {
  const cx = Math.floor(img.width * rect.x);
  const cy = Math.floor(img.height * rect.y);
  const cw = Math.max(24, Math.floor(img.width * rect.width));
  const ch = Math.max(24, Math.floor(img.height * rect.height));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row += 1) {
    const srcRow = Math.min(cy + row, img.height - 1);
    const srcOffset = (srcRow * img.width + cx) * 4;
    const dstOffset = row * cw * 4;
    const copyLen = Math.min(cw * 4, img.data.length - srcOffset);
    if (copyLen > 0) img.data.copy(out, dstOffset, srcOffset, srcOffset + copyLen);
  }
  return { width: cw, height: ch, data: out, channels: 4 };
}

// ── OCR engines ─────────────────────────────────────────────────────────────

let _nativeRecognize: ((input: Buffer | string) => Promise<{ text: string; confidence: number }>) | null = null;
try {
  const mod = require("@napi-rs/system-ocr") as {
    recognize: (input: Buffer | string) => Promise<{ text: string; confidence: number }>;
  };
  _nativeRecognize = mod.recognize;
} catch {
  // not available
}

async function ocrNative(pngBuffer: Buffer): Promise<{ text: string; confidence: number; ms: number }> {
  if (!_nativeRecognize) return { text: "[NOT AVAILABLE]", confidence: 0, ms: 0 };
  const t0 = Date.now();
  const result = await _nativeRecognize(pngBuffer);
  return { text: result.text || "", confidence: result.confidence, ms: Date.now() - t0 };
}

function ocrPowerShell(imagePath: string): Promise<{ text: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", OCR_SCRIPT, imagePath],
      { timeout: 15_000, encoding: "utf8" },
      (err, stdout) => {
        const ms = Date.now() - t0;
        if (err) {
          resolve({ text: `[PS ERROR] ${err.message}`, ms });
          return;
        }
        resolve({ text: stdout || "", ms });
      },
    );
  });
}

// ── Reward matching (production) ────────────────────────────────────────────

// Import the production matching pipeline
import {
  matchItemsDetailed,
  rankRewardCandidatesDetailed,
  normalizeOcrToken,
  norm,
  detectRelicEraFromTileLabelText,
  detectRelicEraFromText,
} from "../services/rewardScannerMatch";

// Load the production item database for realistic matching
let rewardItems: Array<{ name: string }> = [];
let sortedItems: Array<{ name: string }> = [];

async function loadRewardItems(): Promise<void> {
  try {
    // Try loading from relicService / game config
    const relicDataPath = path.join(process.cwd(), "config", "game", "relicRewards.json");
    if (fs.existsSync(relicDataPath)) {
      const data = JSON.parse(fs.readFileSync(relicDataPath, "utf8"));
      if (Array.isArray(data)) {
        rewardItems = data;
      } else if (data.items && Array.isArray(data.items)) {
        rewardItems = data.items;
      }
    }
  } catch {
    // ignore
  }

  // Fallback: use a hardcoded set of common Prime rewards for the benchmark
  if (rewardItems.length === 0) {
    rewardItems = [
      { name: "Forma Blueprint" },
      { name: "Braton Prime Stock" },
      { name: "Braton Prime Receiver" },
      { name: "Braton Prime Barrel" },
      { name: "Braton Prime Blueprint" },
      { name: "Paris Prime Blueprint" },
      { name: "Paris Prime Lower Limb" },
      { name: "Paris Prime Upper Limb" },
      { name: "Paris Prime String" },
      { name: "Paris Prime Grip" },
      { name: "Rhino Prime Blueprint" },
      { name: "Rhino Prime Neuroptics Blueprint" },
      { name: "Rhino Prime Systems Blueprint" },
      { name: "Rhino Prime Chassis Blueprint" },
      { name: "Ember Prime Blueprint" },
      { name: "Ember Prime Neuroptics Blueprint" },
      { name: "Ember Prime Systems Blueprint" },
      { name: "Ember Prime Chassis Blueprint" },
      { name: "Frost Prime Blueprint" },
      { name: "Frost Prime Neuroptics Blueprint" },
      { name: "Frost Prime Systems Blueprint" },
      { name: "Frost Prime Chassis Blueprint" },
      { name: "Loki Prime Blueprint" },
      { name: "Loki Prime Neuroptics Blueprint" },
      { name: "Loki Prime Systems Blueprint" },
      { name: "Loki Prime Chassis Blueprint" },
      { name: "Mag Prime Blueprint" },
      { name: "Mag Prime Neuroptics Blueprint" },
      { name: "Mag Prime Systems Blueprint" },
      { name: "Mag Prime Chassis Blueprint" },
      { name: "Trinity Prime Blueprint" },
      { name: "Trinity Prime Neuroptics Blueprint" },
      { name: "Trinity Prime Systems Blueprint" },
      { name: "Trinity Prime Chassis Blueprint" },
      { name: "Nova Prime Blueprint" },
      { name: "Nova Prime Neuroptics Blueprint" },
      { name: "Nova Prime Systems Blueprint" },
      { name: "Nova Prime Chassis Blueprint" },
      { name: "Volt Prime Blueprint" },
      { name: "Volt Prime Neuroptics Blueprint" },
      { name: "Volt Prime Systems Blueprint" },
      { name: "Volt Prime Chassis Blueprint" },
      { name: "Saryn Prime Blueprint" },
      { name: "Saryn Prime Neuroptics Blueprint" },
      { name: "Saryn Prime Systems Blueprint" },
      { name: "Saryn Prime Chassis Blueprint" },
      { name: "Valkyr Prime Blueprint" },
      { name: "Valkyr Prime Neuroptics Blueprint" },
      { name: "Valkyr Prime Systems Blueprint" },
      { name: "Valkyr Prime Chassis Blueprint" },
      { name: "Banshee Prime Blueprint" },
      { name: "Banshee Prime Neuroptics Blueprint" },
      { name: "Banshee Prime Systems Blueprint" },
      { name: "Banshee Prime Chassis Blueprint" },
      { name: "Oberon Prime Blueprint" },
      { name: "Oberon Prime Neuroptics Blueprint" },
      { name: "Oberon Prime Systems Blueprint" },
      { name: "Oberon Prime Chassis Blueprint" },
      { name: "Hydroid Prime Blueprint" },
      { name: "Hydroid Prime Neuroptics Blueprint" },
      { name: "Hydroid Prime Systems Blueprint" },
      { name: "Hydroid Prime Chassis Blueprint" },
      { name: "Mirage Prime Blueprint" },
      { name: "Mirage Prime Neuroptics Blueprint" },
      { name: "Mirage Prime Systems Blueprint" },
      { name: "Mirage Prime Chassis Blueprint" },
      { name: "Zephyr Prime Blueprint" },
      { name: "Zephyr Prime Neuroptics Blueprint" },
      { name: "Zephyr Prime Systems Blueprint" },
      { name: "Zephyr Prime Chassis Blueprint" },
      { name: "Limbo Prime Blueprint" },
      { name: "Limbo Prime Neuroptics Blueprint" },
      { name: "Limbo Prime Systems Blueprint" },
      { name: "Limbo Prime Chassis Blueprint" },
      { name: "Chroma Prime Blueprint" },
      { name: "Chroma Prime Neuroptics Blueprint" },
      { name: "Chroma Prime Systems Blueprint" },
      { name: "Chroma Prime Chassis Blueprint" },
      { name: "Mesa Prime Blueprint" },
      { name: "Mesa Prime Neuroptics Blueprint" },
      { name: "Mesa Prime Systems Blueprint" },
      { name: "Mesa Prime Chassis Blueprint" },
      { name: "Equinox Prime Blueprint" },
      { name: "Equinox Prime Neuroptics Blueprint" },
      { name: "Equinox Prime Systems Blueprint" },
      { name: "Equinox Prime Chassis Blueprint" },
      { name: "Wukong Prime Blueprint" },
      { name: "Wukong Prime Neuroptics Blueprint" },
      { name: "Wukong Prime Systems Blueprint" },
      { name: "Wukong Prime Chassis Blueprint" },
      { name: "Atlas Prime Blueprint" },
      { name: "Atlas Prime Neuroptics Blueprint" },
      { name: "Atlas Prime Systems Blueprint" },
      { name: "Atlas Prime Chassis Blueprint" },
      { name: "Ivara Prime Blueprint" },
      { name: "Ivara Prime Neuroptics Blueprint" },
      { name: "Ivara Prime Systems Blueprint" },
      { name: "Ivara Prime Chassis Blueprint" },
      { name: "Titania Prime Blueprint" },
      { name: "Titania Prime Neuroptics Blueprint" },
      { name: "Titania Prime Systems Blueprint" },
      { name: "Titania Prime Chassis Blueprint" },
      { name: "Inaros Prime Blueprint" },
      { name: "Inaros Prime Neuroptics Blueprint" },
      { name: "Inaros Prime Systems Blueprint" },
      { name: "Inaros Prime Chassis Blueprint" },
      { name: "Nezha Prime Blueprint" },
      { name: "Nezha Prime Neuroptics Blueprint" },
      { name: "Nezha Prime Systems Blueprint" },
      { name: "Nezha Prime Chassis Blueprint" },
      { name: "Octavia Prime Blueprint" },
      { name: "Octavia Prime Neuroptics Blueprint" },
      { name: "Octavia Prime Systems Blueprint" },
      { name: "Octavia Prime Chassis Blueprint" },
      { name: "Gara Prime Blueprint" },
      { name: "Gara Prime Neuroptics Blueprint" },
      { name: "Gara Prime Systems Blueprint" },
      { name: "Gara Prime Chassis Blueprint" },
      { name: "Nidus Prime Blueprint" },
      { name: "Nidus Prime Neuroptics Blueprint" },
      { name: "Nidus Prime Systems Blueprint" },
      { name: "Nidus Prime Chassis Blueprint" },
      { name: "Harrow Prime Blueprint" },
      { name: "Harrow Prime Neuroptics Blueprint" },
      { name: "Harrow Prime Systems Blueprint" },
      { name: "Harrow Prime Chassis Blueprint" },
      { name: "Revenant Prime Blueprint" },
      { name: "Revenant Prime Neuroptics Blueprint" },
      { name: "Revenant Prime Systems Blueprint" },
      { name: "Revenant Prime Chassis Blueprint" },
      { name: "Baruuk Prime Blueprint" },
      { name: "Baruuk Prime Neuroptics Blueprint" },
      { name: "Baruuk Prime Systems Blueprint" },
      { name: "Baruuk Prime Chassis Blueprint" },
      { name: "Hildryn Prime Blueprint" },
      { name: "Hildryn Prime Neuroptics Blueprint" },
      { name: "Hildryn Prime Systems Blueprint" },
      { name: "Hildryn Prime Chassis Blueprint" },
      { name: "Wisp Prime Blueprint" },
      { name: "Wisp Prime Neuroptics Blueprint" },
      { name: "Wisp Prime Systems Blueprint" },
      { name: "Wisp Prime Chassis Blueprint" },
      { name: "Protea Prime Blueprint" },
      { name: "Protea Prime Neuroptics Blueprint" },
      { name: "Protea Prime Systems Blueprint" },
      { name: "Protea Prime Chassis Blueprint" },
      { name: "Xaku Prime Blueprint" },
      { name: "Xaku Prime Neuroptics Blueprint" },
      { name: "Xaku Prime Systems Blueprint" },
      { name: "Xaku Prime Chassis Blueprint" },
      { name: "Garuda Prime Blueprint" },
      { name: "Garuda Prime Neuroptics Blueprint" },
      { name: "Garuda Prime Systems Blueprint" },
      { name: "Garuda Prime Chassis Blueprint" },
      { name: "Caliban Prime Blueprint" },
      { name: "Caliban Prime Neuroptics Blueprint" },
      { name: "Caliban Prime Systems Blueprint" },
      { name: "Caliban Prime Chassis Blueprint" },
      { name: "Trumna Prime Blueprint" },
      { name: "Trumna Prime Barrel" },
      { name: "Trumna Prime Receiver" },
      { name: "Trumna Prime Stock" },
      { name: "Nautilus Prime Blueprint" },
      { name: "Nautilus Prime Systems" },
      { name: "Nautilus Prime Cerebrum" },
      { name: "Nautilus Prime Carapace" },
      { name: "Epitaph Prime Blueprint" },
      { name: "Epitaph Prime Barrel" },
      { name: "Epitaph Prime Receiver" },
      { name: "Soma Prime Blueprint" },
      { name: "Soma Prime Barrel" },
      { name: "Soma Prime Receiver" },
      { name: "Soma Prime Stock" },
      { name: "Nikana Prime Blueprint" },
      { name: "Nikana Prime Blade" },
      { name: "Nikana Prime Hilt" },
      { name: "Orthos Prime Blueprint" },
      { name: "Orthos Prime Blade" },
      { name: "Orthos Prime Handle" },
      { name: "Carrier Prime Blueprint" },
      { name: "Carrier Prime Systems" },
      { name: "Carrier Prime Cerebrum" },
      { name: "Carrier Prime Carapace" },
      { name: "Akstiletto Prime Blueprint" },
      { name: "Akstiletto Prime Barrel" },
      { name: "Akstiletto Prime Receiver" },
      { name: "Akstiletto Prime Link" },
      { name: "Tigris Prime Blueprint" },
      { name: "Tigris Prime Barrel" },
      { name: "Tigris Prime Receiver" },
      { name: "Tigris Prime Stock" },
      { name: "Galatine Prime Blueprint" },
      { name: "Galatine Prime Blade" },
      { name: "Galatine Prime Handle" },
      { name: "Nekros Prime Blueprint" },
      { name: "Nekros Prime Neuroptics Blueprint" },
      { name: "Nekros Prime Systems Blueprint" },
      { name: "Nekros Prime Chassis Blueprint" },
      { name: "Vauban Prime Blueprint" },
      { name: "Vauban Prime Neuroptics Blueprint" },
      { name: "Vauban Prime Systems Blueprint" },
      { name: "Vauban Prime Chassis Blueprint" },
      { name: "Ash Prime Blueprint" },
      { name: "Ash Prime Neuroptics Blueprint" },
      { name: "Ash Prime Systems Blueprint" },
      { name: "Ash Prime Chassis Blueprint" },
      { name: "Kavasa Prime Band" },
      { name: "Kavasa Prime Buckle" },
      { name: "Kavasa Prime Collar Blueprint" },
      { name: "Odonata Prime Blueprint" },
      { name: "Odonata Prime Systems Blueprint" },
      { name: "Odonata Prime Harness Blueprint" },
      { name: "Odonata Prime Wings Blueprint" },
    ];
  }

  sortedItems = [...rewardItems].sort((a, b) => b.name.length - a.name.length);
  console.log(`Loaded ${rewardItems.length} reward items for matching.\n`);
}

// ── Riven stat parsing (from test-riven-ocr.ts) ────────────────────────────

const KNOWN_RIVEN_STATS: string[] = [
  "Additional Combo Count Chance", "Chance to Gain Combo Count",
  "Critical Chance for Slide Attack", "Heavy Attack Efficiency",
  "Magazine Capacity", "Damage to Grineer", "Damage to Corpus",
  "Damage to Infested", "Critical Chance", "Critical Damage",
  "Finisher Damage", "Melee Damage", "Weapon Recoil", "Status Duration",
  "Status Chance", "Projectile Speed", "Reload Speed", "Attack Speed",
  "Flight Speed", "Fire Rate", "Punch Through", "Combo Duration",
  "Initial Combo", "Ammo Maximum", "Heavy Attack", "Channeling Damage",
  "Channeling Efficiency", "Multishot",
  "Electricity", "Corrosive", "Radiation", "Magnetic",
  "Cold", "Heat", "Toxin", "Viral", "Blast", "Gas",
  "Impact", "Puncture", "Slash",
  "Magazine", "Recoil", "Damage", "Range", "Slide", "Zoom",
];

interface RivenStat {
  name: string;
  positive: boolean;
  value: number | null;
}

function preprocessOcrText(raw: string): string {
  let text = raw;
  text = text.replace(/0\/0/g, "%");
  text = text.replace(/O\/O/gi, "%");
  text = text.replace(/o\/o/g, "%");
  text = text.replace(/(\d)\s*Z\b/g, "$1%");
  text = text.replace(/,(\d)/g, ".$1");
  text = text.replace(/(\d)\s([1-9])\s*%/g, "$1.$2%");
  for (let pass = 0; pass < 5; pass++) text = text.replace(/([+\-\u2013]\s*\d+)\s+(\d)/g, "$1$2");
  for (let pass = 0; pass < 5; pass++) text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  text = text.replace(/(\d)[A-Za-z](\d)/g, "$1$2");
  for (let pass = 0; pass < 3; pass++) text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  text = text.replace(/Dannage/gi, "Damage");
  text = text.replace(/Darnage/gi, "Damage");
  text = text.replace(/Crit\s*ical/gi, "Critical");
  text = text.replace(/Multi\s*shot/gi, "Multishot");
  text = text.replace(/Sta tus/gi, "Status");
  text = text.replace(/Re load/gi, "Reload");
  text = text.replace(/Elec tricity/gi, "Electricity");
  text = text.replace(/Punc ture/gi, "Puncture");
  text = text.replace(/Maga zine/gi, "Magazine");
  text = text.replace(/Capaclty/gi, "Capacity");
  text = text.replace(/Mel[ae]e/gi, "Melee");
  text = text.replace(/[>]?[lh]mpact/gi, "Impact");
  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");
  text = text.replace(/[*()\[\]{}|\\<>^~°©®™•→←↑↓↗↘►◄▸▾▲▼■□●○]+\s*/g, " ");
  text = text.replace(/\bx\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\b/gi, "");
  text = text.replace(/\bG[Ll]ash\b/gi, "Slash");
  text = text.replace(/\bY\s*Puncture\b/gi, "Puncture");
  text = text.replace(/\bA\s*Slash\b/gi, "Slash");
  text = text.replace(/\bO\s*Cold\b/gi, "Cold");
  text = text.replace(/\bO\s*Heat\b/gi, "Heat");
  text = text.replace(/\bQ\s*Toxin\b/gi, "Toxin");
  text = text.replace(/\bQ\s*Electricity\b/gi, "Electricity");
  text = text.replace(
    /[0-9'"`]\s*(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi, "",
  );
  text = text.replace(
    /\b[A-Z]\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/g, "",
  );
  text = text.replace(/Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi, "Critical Chance for Slide Attack");
  text = text.replace(/(\d)s(?=\s|$)/g, "$1");
  text = text.replace(/\s+([+\-\u2013]\d)/g, "\n$1");
  text = text.replace(/\s+(x\d)/gi, "\n$1");
  return text;
}

function parseRivenStats(raw: string): RivenStat[] {
  const text = preprocessOcrText(raw);
  const lines = text.split(/\r?\n/);
  const results: RivenStat[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineLower = line.toLowerCase();

    const hits: Array<{ stat: string; idx: number }> = [];
    for (const stat of KNOWN_RIVEN_STATS) {
      const idx = lineLower.indexOf(stat.toLowerCase());
      if (idx !== -1) hits.push({ stat, idx });
    }
    if (hits.length === 0) continue;

    hits.sort((a, b) => a.idx - b.idx || b.stat.length - a.stat.length);
    const filtered: typeof hits = [];
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.idx >= lastEnd) { filtered.push(hit); lastEnd = hit.idx + hit.stat.length; }
    }

    for (const { stat, idx } of filtered) {
      const key = stat.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const prefix = line.slice(0, idx);
      const signMatch = prefix.match(/[+\-\u2013]/);
      const positive = !signMatch || signMatch[0] === "+";
      const valMatch = prefix.match(/(\d+\.?\d*)\s*%?/);
      const suffix = line.slice(idx + stat.length);
      const suffixValMatch = suffix.match(/(\d+\.?\d*)\s*%?/);
      const value = valMatch ? parseFloat(valMatch[1]) : (suffixValMatch ? parseFloat(suffixValMatch[1]) : null);
      results.push({ name: stat, positive, value });
    }
  }
  return results;
}

// ── Reward benchmark ────────────────────────────────────────────────────────

// Reward slot layouts (detect player count by filename or squad icon detection)
const REWARD_BAND = { top: 0.38, height: 0.36 };
const FIXED_REWARD_TITLE_RECTS: Record<number, Array<{ x: number; y: number; width: number; height: number }>> = {
  2: [
    { x: 0.37, y: 0.225 + 0.225 * 0.7, width: 0.17, height: 0.225 * 0.18 },
    { x: 0.54, y: 0.225 + 0.225 * 0.7, width: 0.17, height: 0.225 * 0.18 },
  ],
  3: [
    { x: 0.29, y: 0.225 + 0.225 * 0.7, width: 0.15, height: 0.225 * 0.18 },
    { x: 0.44, y: 0.225 + 0.225 * 0.7, width: 0.15, height: 0.225 * 0.18 },
    { x: 0.59, y: 0.225 + 0.225 * 0.7, width: 0.15, height: 0.225 * 0.18 },
  ],
  4: [
    { x: 0.245, y: 0.225 + 0.225 * 0.7, width: 0.122, height: 0.225 * 0.18 },
    { x: 0.372, y: 0.225 + 0.225 * 0.7, width: 0.122, height: 0.225 * 0.18 },
    { x: 0.499, y: 0.225 + 0.225 * 0.7, width: 0.122, height: 0.225 * 0.18 },
    { x: 0.626, y: 0.225 + 0.225 * 0.7, width: 0.122, height: 0.225 * 0.18 },
  ],
};

function getPlayerCountFromFilename(filename: string): number {
  const match = filename.match(/(\d)_players?/i);
  return match ? parseInt(match[1], 10) : 4;
}

async function benchmarkRewardImage(
  filePath: string,
  lines: string[],
): Promise<{ nativeItems: number; psItems: number; nativeMs: number; psMs: number }> {
  const filename = path.basename(filePath);
  const playerCount = getPlayerCountFromFilename(filename);
  const img = await loadImage(filePath);

  lines.push(`\n┌─────────────────────────────────────────────────────────`);
  lines.push(`│ Reward Image: ${filename} (${img.width}x${img.height}, ${playerCount} players)`);
  lines.push(`└─────────────────────────────────────────────────────────`);

  const tmpDir = path.join(process.cwd(), "OCR-debug", ".benchmark-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Strategy A: Full band OCR (how the production scanner works)
  const bandCrop = cropImage(img, {
    x: 0,
    y: REWARD_BAND.top,
    width: 1,
    height: REWARD_BAND.height,
  });
  const bandPngPath = path.join(tmpDir, `band-${filename}`);
  await savePng(bandPngPath, bandCrop);
  const bandPngBuffer = fs.readFileSync(bandPngPath);

  lines.push(`\n  ── Strategy: Full Band OCR ──`);
  lines.push(`  Band region: top=${REWARD_BAND.top} height=${REWARD_BAND.height}`);
  lines.push(`  Band size: ${bandCrop.width}x${bandCrop.height}`);

  // Native OCR on full band
  const nativeBand = await ocrNative(bandPngBuffer);
  const nativeBandMatch = matchItemsDetailed(nativeBand.text, 0.86, sortedItems);
  lines.push(`\n  [Native WinRT] ${nativeBand.ms}ms, confidence=${nativeBand.confidence.toFixed(3)}`);
  lines.push(`  OCR text: "${nativeBand.text.replace(/\r?\n/g, " | ").trim().slice(0, 200)}"`);
  lines.push(`  Matched: ${nativeBandMatch.items.length} items (${nativeBandMatch.exactCount} exact), score=${nativeBandMatch.score.toFixed(2)}`);
  for (const item of nativeBandMatch.items) {
    lines.push(`    → ${item.name} (conf=${item.confidence})`);
  }

  // PowerShell OCR on full band
  const psBand = await ocrPowerShell(bandPngPath);
  const psBandMatch = matchItemsDetailed(psBand.text, 0.86, sortedItems);
  lines.push(`\n  [PowerShell] ${psBand.ms}ms`);
  lines.push(`  OCR text: "${psBand.text.replace(/\r?\n/g, " | ").trim().slice(0, 200)}"`);
  lines.push(`  Matched: ${psBandMatch.items.length} items (${psBandMatch.exactCount} exact), score=${psBandMatch.score.toFixed(2)}`);
  for (const item of psBandMatch.items) {
    lines.push(`    → ${item.name} (conf=${item.confidence})`);
  }

  // Strategy B: Per-slot OCR (the slot-first/fallback strategy)
  const slotRects = FIXED_REWARD_TITLE_RECTS[playerCount];
  if (slotRects) {
    lines.push(`\n  ── Strategy: Per-Slot OCR (${slotRects.length} slots) ──`);
    let nativeSlotTotal = 0;
    let psSlotTotal = 0;
    const nativeSlotItems: string[] = [];
    const psSlotItems: string[] = [];

    for (let i = 0; i < slotRects.length; i++) {
      const slotCrop = cropImage(img, slotRects[i]);
      const slotPath = path.join(tmpDir, `slot-${i}-${filename}`);
      await savePng(slotPath, slotCrop);
      const slotBuffer = fs.readFileSync(slotPath);

      const nativeSlot = await ocrNative(slotBuffer);
      nativeSlotTotal += nativeSlot.ms;
      const nativeRanked = rankRewardCandidatesDetailed(nativeSlot.text, sortedItems, 3);
      const nativeBest = nativeRanked[0];
      nativeSlotItems.push(nativeBest?.item?.name || "(none)");
      lines.push(`  Slot ${i + 1} [Native] ${nativeSlot.ms}ms: "${nativeSlot.text.replace(/\r?\n/g, " ").trim().slice(0, 80)}"`);
      lines.push(`    → ${nativeBest?.item?.name || "(none)"} (conf=${nativeBest?.confidence?.toFixed(3) || 0}, mode=${nativeBest?.mode || "none"})`);

      const psSlot = await ocrPowerShell(slotPath);
      psSlotTotal += psSlot.ms;
      const psRanked = rankRewardCandidatesDetailed(psSlot.text, sortedItems, 3);
      const psBest = psRanked[0];
      psSlotItems.push(psBest?.item?.name || "(none)");
      lines.push(`  Slot ${i + 1} [PS]     ${psSlot.ms}ms: "${psSlot.text.replace(/\r?\n/g, " ").trim().slice(0, 80)}"`);
      lines.push(`    → ${psBest?.item?.name || "(none)"} (conf=${psBest?.confidence?.toFixed(3) || 0}, mode=${psBest?.mode || "none"})`);

      try { fs.unlinkSync(slotPath); } catch { /* ignore */ }
    }

    lines.push(`\n  Slot summary [Native] (${nativeSlotTotal}ms total): ${nativeSlotItems.join(" | ")}`);
    lines.push(`  Slot summary [PS]     (${psSlotTotal}ms total): ${psSlotItems.join(" | ")}`);
  }

  try { fs.unlinkSync(bandPngPath); } catch { /* ignore */ }

  return {
    nativeItems: nativeBandMatch.items.length,
    psItems: psBandMatch.items.length,
    nativeMs: nativeBand.ms,
    psMs: psBand.ms,
  };
}

// ── Relic selection crop config ─────────────────────────────────────────────

// Mirrors RELIC_ROW_TILE_LABEL_RECTS from services/rewardScanner.ts
const RELIC_SLOT_RECTS = [
  { id: "slot-1", x: 0.02, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-2", x: 0.2,  y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-3", x: 0.38, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-4", x: 0.56, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-5", x: 0.74, y: 0.5, width: 0.18, height: 0.42 },
] as const;

// Mirrors RELIC_ERA_BANDS from services/rewardScanner.ts
const RELIC_ERA_BANDS = [
  { id: "band-1", x: 0, y: 0.12, width: 1, height: 0.12 },
  { id: "band-2", x: 0, y: 0.16, width: 1, height: 0.13 },
  { id: "band-3", x: 0, y: 0.20, width: 1, height: 0.14 },
] as const;

// ── Riven benchmark ─────────────────────────────────────────────────────────

const RIVEN_CROPS = {
  LEFT_STATS: { x: 0.20, y: 0.52, width: 0.28, height: 0.22 },
  RIGHT_STATS: { x: 0.50, y: 0.52, width: 0.28, height: 0.22 },
  FULL_LOWER: { x: 0.02, y: 0.45, width: 0.96, height: 0.42 },
  SINGLE_CARD: { x: 0.30, y: 0.38, width: 0.40, height: 0.38 },
};

async function upscaleForOcr(img: ImageInfo, minWidth: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  if (img.width >= minWidth) {
    return sharp(Buffer.from(img.data), {
      raw: { width: img.width, height: img.height, channels: img.channels },
    }).png().toBuffer();
  }
  const scale = Math.ceil(minWidth / img.width);
  const newW = Math.min(6000, img.width * scale);
  const newH = Math.min(6000, img.height * scale);
  return sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  }).resize(newW, newH, { kernel: "lanczos3" }).png().toBuffer();
}

async function benchmarkRivenImage(
  filePath: string,
  lines: string[],
): Promise<{ nativeStats: number; psStats: number; nativeMs: number; psMs: number }> {
  const filename = path.basename(filePath);
  const img = await loadImage(filePath);
  const isMultipanel = filename.toLowerCase().includes("multipanel");

  lines.push(`\n┌─────────────────────────────────────────────────────────`);
  lines.push(`│ Riven Image: ${filename} (${img.width}x${img.height}${isMultipanel ? ", multipanel" : ""})`);
  lines.push(`└─────────────────────────────────────────────────────────`);

  const tmpDir = path.join(process.cwd(), "OCR-debug", ".benchmark-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Determine which crop regions to use
  const aspect = img.width / img.height;
  let cropEntries: Array<[string, { x: number; y: number; width: number; height: number }]>;

  if (img.width >= 1600) {
    cropEntries = isMultipanel
      ? [["left-stats", RIVEN_CROPS.LEFT_STATS], ["right-stats", RIVEN_CROPS.RIGHT_STATS]]
      : [["left-stats", RIVEN_CROPS.LEFT_STATS], ["right-stats", RIVEN_CROPS.RIGHT_STATS], ["full-lower", RIVEN_CROPS.FULL_LOWER]];
  } else if (aspect < 1.0) {
    cropEntries = [["stats-area", { x: 0.02, y: 0.58, width: 0.96, height: 0.28 }]];
  } else {
    cropEntries = [["full-lower", RIVEN_CROPS.FULL_LOWER]];
  }

  let bestNativeStats = 0;
  let bestPsStats = 0;
  let totalNativeMs = 0;
  let totalPsMs = 0;

  for (const [regionName, cropDef] of cropEntries) {
    const cropped = cropImage(img, cropDef);
    const upscaledBuf = await upscaleForOcr(cropped, 1800);
    const tmpPath = path.join(tmpDir, `riven-${regionName}-${filename}.png`);
    fs.writeFileSync(tmpPath, upscaledBuf);

    lines.push(`\n  ── Region: ${regionName} (${cropped.width}x${cropped.height}) ──`);

    // Native OCR
    const nativeResult = await ocrNative(upscaledBuf);
    totalNativeMs += nativeResult.ms;
    const nativeStats = parseRivenStats(nativeResult.text);
    const statsWithValues = nativeStats.filter((s) => s.value !== null).length;
    if (nativeStats.length > bestNativeStats) bestNativeStats = nativeStats.length;
    lines.push(`  [Native] ${nativeResult.ms}ms, confidence=${nativeResult.confidence.toFixed(3)}`);
    lines.push(`  OCR text: "${nativeResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 200)}"`);
    lines.push(`  Parsed: ${nativeStats.length} stats (${statsWithValues} with values)`);
    for (const stat of nativeStats) {
      lines.push(`    ${stat.positive ? "+" : "-"}${stat.value ?? "?"} ${stat.name}`);
    }

    // PowerShell OCR
    const psResult = await ocrPowerShell(tmpPath);
    totalPsMs += psResult.ms;
    const psStats = parseRivenStats(psResult.text);
    const psStatsWithValues = psStats.filter((s) => s.value !== null).length;
    if (psStats.length > bestPsStats) bestPsStats = psStats.length;
    lines.push(`  [PS]     ${psResult.ms}ms`);
    lines.push(`  OCR text: "${psResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 200)}"`);
    lines.push(`  Parsed: ${psStats.length} stats (${psStatsWithValues} with values)`);
    for (const stat of psStats) {
      lines.push(`    ${stat.positive ? "+" : "-"}${stat.value ?? "?"} ${stat.name}`);
    }

    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  return {
    nativeStats: bestNativeStats,
    psStats: bestPsStats,
    nativeMs: totalNativeMs,
    psMs: totalPsMs,
  };
}

// ── Relic selection benchmark ───────────────────────────────────────────────

async function benchmarkRelicImage(
  filePath: string,
  lines: string[],
): Promise<{ era: string | null; confidence: number; nativeMs: number; psMs: number }> {
  const filename = path.basename(filePath);
  const img = await loadImage(filePath);

  lines.push(`\n┌─────────────────────────────────────────────────────────`);
  lines.push(`│ Relic Selection Image: ${filename} (${img.width}x${img.height})`);
  lines.push(`└─────────────────────────────────────────────────────────`);

  const tmpDir = path.join(process.cwd(), "OCR-debug", ".benchmark-tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let bestEra: string | null = null;
  let bestConf = 0;
  let bestHitId = "none";
  let totalNativeMs = 0;
  let totalPsMs = 0;

  // ── Phase 1: slot tile label crops ──
  lines.push(`\n  ── Phase 1: Slot tile label crops (${RELIC_SLOT_RECTS.length} slots) ──`);
  for (const rect of RELIC_SLOT_RECTS) {
    const cropped = cropImage(img, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    const upscaled = await upscaleForOcr(cropped, 900);
    const tmpPath = path.join(tmpDir, `relic-${rect.id}-${filename}.png`);
    fs.writeFileSync(tmpPath, upscaled);

    lines.push(`\n    [${rect.id}] crop ${cropped.width}x${cropped.height}`);

    const nativeResult = await ocrNative(upscaled);
    totalNativeMs += nativeResult.ms;
    const nativeHit = detectRelicEraFromTileLabelText(nativeResult.text);
    lines.push(`    [Native] ${nativeResult.ms}ms | text: "${nativeResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 120)}"`);
    lines.push(`    [Native] era=${nativeHit.era ?? "none"} conf=${nativeHit.confidence.toFixed(3)}`);
    if (nativeHit.confidence > bestConf) {
      bestConf = nativeHit.confidence;
      bestEra = nativeHit.era;
      bestHitId = `${rect.id}/native`;
    }

    const psResult = await ocrPowerShell(tmpPath);
    totalPsMs += psResult.ms;
    const psHit = detectRelicEraFromTileLabelText(psResult.text);
    lines.push(`    [PS]     ${psResult.ms}ms | text: "${psResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 120)}"`);
    lines.push(`    [PS]     era=${psHit.era ?? "none"} conf=${psHit.confidence.toFixed(3)}`);
    if (psHit.confidence > bestConf) {
      bestConf = psHit.confidence;
      bestEra = psHit.era;
      bestHitId = `${rect.id}/ps`;
    }

    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

    if (bestConf >= 0.99) break;
  }

  // ── Phase 2: era band fallback (only if confidence < 0.9) ──
  if (bestConf < 0.9) {
    lines.push(`\n  ── Phase 2: Era band fallback (conf=${bestConf.toFixed(3)} < 0.9, trying ${RELIC_ERA_BANDS.length} bands) ──`);
    for (const band of RELIC_ERA_BANDS) {
      const cropped = cropImage(img, { x: band.x, y: band.y, width: band.width, height: band.height });
      const upscaled = await upscaleForOcr(cropped, 1200);
      const tmpPath = path.join(tmpDir, `relic-${band.id}-${filename}.png`);
      fs.writeFileSync(tmpPath, upscaled);

      lines.push(`\n    [${band.id}] crop ${cropped.width}x${cropped.height}`);

      const nativeResult = await ocrNative(upscaled);
      totalNativeMs += nativeResult.ms;
      const nativeHit = detectRelicEraFromText(nativeResult.text);
      lines.push(`    [Native] ${nativeResult.ms}ms | text: "${nativeResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 120)}"`);
      lines.push(`    [Native] era=${nativeHit.era ?? "none"} conf=${nativeHit.confidence.toFixed(3)}`);
      if (nativeHit.confidence > bestConf) {
        bestConf = nativeHit.confidence;
        bestEra = nativeHit.era;
        bestHitId = `${band.id}/native`;
      }

      const psResult = await ocrPowerShell(tmpPath);
      totalPsMs += psResult.ms;
      const psHit = detectRelicEraFromText(psResult.text);
      lines.push(`    [PS]     ${psResult.ms}ms | text: "${psResult.text.replace(/\r?\n/g, " | ").trim().slice(0, 120)}"`);
      lines.push(`    [PS]     era=${psHit.era ?? "none"} conf=${psHit.confidence.toFixed(3)}`);
      if (psHit.confidence > bestConf) {
        bestConf = psHit.confidence;
        bestEra = psHit.era;
        bestHitId = `${band.id}/ps`;
      }

      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      if (bestConf >= 0.99) break;
    }
  } else {
    lines.push(`  (Phase 2 skipped — confident detection at conf=${bestConf.toFixed(3)})`);
  }

  lines.push(`\n  ── Result ──`);
  lines.push(`  Era: ${bestEra ?? "UNKNOWN"} | conf=${bestConf.toFixed(3)} | source=${bestHitId}`);
  lines.push(`  Total native OCR: ${totalNativeMs}ms | Total PS OCR: ${totalPsMs}ms`);

  return { era: bestEra, confidence: bestConf, nativeMs: totalNativeMs, psMs: totalPsMs };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const rewardsOnly = args.includes("--rewards-only");
  const rivensOnly = args.includes("--rivens-only");
  const relicOnly = args.includes("--relic-only");

  const lines: string[] = [];
  lines.push(`╔═══════════════════════════════════════════════════════════╗`);
  lines.push(`║     OCR Pipeline Benchmark — ${new Date().toISOString()}     ║`);
  lines.push(`╚═══════════════════════════════════════════════════════════╝`);
  lines.push(``);
  lines.push(`Native OCR: ${_nativeRecognize ? "AVAILABLE (@napi-rs/system-ocr)" : "NOT AVAILABLE"}`);
  lines.push(`PowerShell OCR: scripts/ocr.ps1`);

  await loadRewardItems();

  const summaryReward: Array<{ file: string; nativeItems: number; psItems: number; nativeMs: number; psMs: number }> = [];
  const summaryRiven: Array<{ file: string; nativeStats: number; psStats: number; nativeMs: number; psMs: number }> = [];
  const summaryRelic: Array<{ file: string; era: string | null; confidence: number; nativeMs: number; psMs: number }> = [];

  // ── Reward images ──
  if (!rivensOnly && !relicOnly && fs.existsSync(REWARD_CORPUS)) {
    const rewardFiles = fs.readdirSync(REWARD_CORPUS).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
    lines.push(`\n${"═".repeat(60)}`);
    lines.push(`  REWARD IMAGES (${rewardFiles.length} files from OCR-debug/reward_images/)`);
    lines.push(`${"═".repeat(60)}`);

    for (const file of rewardFiles) {
      const result = await benchmarkRewardImage(path.join(REWARD_CORPUS, file), lines);
      summaryReward.push({ file, ...result });
    }
  }

  // ── Riven images ──
  if (!rewardsOnly && !relicOnly && fs.existsSync(RIVEN_CORPUS)) {
    const rivenFiles = fs.readdirSync(RIVEN_CORPUS).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
    lines.push(`\n${"═".repeat(60)}`);
    lines.push(`  RIVEN IMAGES (${rivenFiles.length} files from OCR-debug/riven_images/)`);
    lines.push(`${"═".repeat(60)}`);

    for (const file of rivenFiles) {
      const result = await benchmarkRivenImage(path.join(RIVEN_CORPUS, file), lines);
      summaryRiven.push({ file, ...result });
    }
  }

  // ── Relic selection images ──
  if (!rewardsOnly && !rivensOnly && fs.existsSync(RELIC_CORPUS)) {
    const relicFiles = fs.readdirSync(RELIC_CORPUS).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
    lines.push(`\n${"═".repeat(60)}`);
    lines.push(`  RELIC SELECTION IMAGES (${relicFiles.length} files from OCR-debug/relic_selection/)`);
    lines.push(`${"═".repeat(60)}`);

    for (const file of relicFiles) {
      const result = await benchmarkRelicImage(path.join(RELIC_CORPUS, file), lines);
      summaryRelic.push({ file, ...result });
    }
  }

  // ── Summary tables ──
  lines.push(`\n${"═".repeat(60)}`);
  lines.push(`  SUMMARY`);
  lines.push(`${"═".repeat(60)}`);

  if (summaryReward.length > 0) {
    lines.push(`\n  ── Rewards ──`);
    lines.push(`  ${"File".padEnd(20)} ${"Native".padEnd(20)} ${"PowerShell".padEnd(20)}`);
    lines.push(`  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(20)}`);
    let totalNativeItems = 0, totalPsItems = 0, totalNativeMs = 0, totalPsMs = 0;
    for (const r of summaryReward) {
      const nCol = `${r.nativeItems} items, ${r.nativeMs}ms`;
      const pCol = `${r.psItems} items, ${r.psMs}ms`;
      lines.push(`  ${r.file.padEnd(20)} ${nCol.padEnd(20)} ${pCol.padEnd(20)}`);
      totalNativeItems += r.nativeItems;
      totalPsItems += r.psItems;
      totalNativeMs += r.nativeMs;
      totalPsMs += r.psMs;
    }
    lines.push(`  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(20)}`);
    lines.push(`  ${"TOTAL".padEnd(20)} ${`${totalNativeItems} items, ${totalNativeMs}ms`.padEnd(20)} ${`${totalPsItems} items, ${totalPsMs}ms`.padEnd(20)}`);
  }

  if (summaryRiven.length > 0) {
    lines.push(`\n  ── Rivens ──`);
    lines.push(`  ${"File".padEnd(28)} ${"Native".padEnd(20)} ${"PowerShell".padEnd(20)}`);
    lines.push(`  ${"─".repeat(28)} ${"─".repeat(20)} ${"─".repeat(20)}`);
    let totalNativeStats = 0, totalPsStats = 0, totalNativeMs = 0, totalPsMs = 0;
    for (const r of summaryRiven) {
      const nCol = `${r.nativeStats} stats, ${r.nativeMs}ms`;
      const pCol = `${r.psStats} stats, ${r.psMs}ms`;
      lines.push(`  ${r.file.padEnd(28)} ${nCol.padEnd(20)} ${pCol.padEnd(20)}`);
      totalNativeStats += r.nativeStats;
      totalPsStats += r.psStats;
      totalNativeMs += r.nativeMs;
      totalPsMs += r.psMs;
    }
    lines.push(`  ${"─".repeat(28)} ${"─".repeat(20)} ${"─".repeat(20)}`);
    lines.push(`  ${"TOTAL".padEnd(28)} ${`${totalNativeStats} stats, ${totalNativeMs}ms`.padEnd(20)} ${`${totalPsStats} stats, ${totalPsMs}ms`.padEnd(20)}`);
  }

  if (summaryRelic.length > 0) {
    lines.push(`\n  ── Relic Selection ──`);
    lines.push(`  ${"File".padEnd(28)} ${"Era".padEnd(16)} ${"Conf".padEnd(8)} ${"Native".padEnd(14)} ${"PS".padEnd(14)}`);
    lines.push(`  ${"─".repeat(28)} ${"─".repeat(16)} ${"─".repeat(8)} ${"─".repeat(14)} ${"─".repeat(14)}`);
    for (const r of summaryRelic) {
      const eraCol = (r.era ?? "UNKNOWN").padEnd(16);
      const confCol = r.confidence.toFixed(3).padEnd(8);
      const nCol = `${r.nativeMs}ms`.padEnd(14);
      const pCol = `${r.psMs}ms`.padEnd(14);
      lines.push(`  ${r.file.padEnd(28)} ${eraCol} ${confCol} ${nCol} ${pCol}`);
    }
  }

  const output = lines.join("\n");
  console.log(output);
  fs.writeFileSync(OUTPUT_FILE, output, "utf8");
  console.log(`\nResults saved to ${OUTPUT_FILE}`);

  // Cleanup tmp dir
  const tmpDir = path.join(process.cwd(), "OCR-debug", ".benchmark-tmp");
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
