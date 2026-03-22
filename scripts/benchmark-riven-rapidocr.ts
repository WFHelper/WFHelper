#!/usr/bin/env npx tsx
/**
 * RapidOCR benchmark for the riven corpus.
 *
 * Runs `scripts/rapidocr_riven_runner.py` (RapidOCR via onnxruntime) and then
 * parses/scorers the returned text using the production TS parser.
 *
 * Usage:
 *   npx tsx scripts/benchmark-riven-rapidocr.ts
 *   npx tsx scripts/benchmark-riven-rapidocr.ts --refined
 *   npx tsx scripts/benchmark-riven-rapidocr.ts --limit 3
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  parseRivenStats,
  scoreStatsCandidate,
  type RivenStat,
} from "../ipc/overlay/rivenScanText.js";

const VARIANT = process.argv.includes("--refined") ? "refined" : "rough";

function readArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const LIMIT = Number.parseInt(readArgValue("--limit") ?? "0", 10) || 0;

function normalizeRapidOcrText(text: string): string {
  let out = String(text || "");
  // RapidOCR often returns concatenated tokens: "+126,2%StatusDuration".
  out = out.replace(/%([A-Za-z])/g, "% $1");
  out = out.replace(/([0-9])([A-Za-z])/g, "$1 $2");
  out = out.replace(/([a-z])([A-Z])/g, "$1 $2");
  out = out.replace(/\bDamageto\b/gi, "Damage to");
  out = out.replace(/\bChancefor\b/gi, "Chance for");
  out = out.replace(/[ \t]+/g, " ");
  return out;
}

function formatStats(stats: RivenStat[]): string {
  if (!stats.length) return "(none)";
  return stats
    .map((s) => {
      const sign = s.positive ? "+" : "-";
      const val = s.value === null ? "?" : s.multiplier ? `x${s.value}` : `${s.value}%`;
      return `${sign}${val} ${s.name}`;
    })
    .join(", ");
}

// ── Ground truth (copied from benchmark-riven-production.ts) ─────────────────
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
  "real_production_initial.png": [
    { name: "Damage to Corpus", value: 1.3, positive: true, multiplier: true },
    { name: "Damage to Grineer", value: 1.36, positive: true, multiplier: true },
    { name: "Heat", value: 62.2, positive: true },
    { name: "Impact", value: 68.4, positive: false },
  ],
};

function scoreAccuracy(
  stats: RivenStat[],
  expected: (typeof GROUND_TRUTH)[string],
): { namesMatched: number; valuesMatched: number; signsMatched: number; totalExpected: number } {
  let namesMatched = 0;
  let valuesMatched = 0;
  let signsMatched = 0;
  const totalExpected = expected.length;

  for (const exp of expected) {
    const found = stats.find((s) => s.name.toLowerCase() === exp.name.toLowerCase());
    if (!found) continue;
    namesMatched++;
    const signOk = found.positive === exp.positive;
    if (exp.value === null) {
      if (found.value !== null) {
        valuesMatched++;
        if (signOk) signsMatched++;
      }
      continue;
    }
    if (found.value !== null && Math.abs(found.value - exp.value) < 3) {
      valuesMatched++;
      if (signOk) signsMatched++;
    }
  }

  return { namesMatched, valuesMatched, signsMatched, totalExpected };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function runPythonRunner(): Promise<any[]> {
  const runnerPath = path.join(process.cwd(), "scripts", "rapidocr_riven_runner.py");
  const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`Missing runner: ${runnerPath}`);
  }
  if (!fs.existsSync(corpusDir)) {
    throw new Error(`Missing corpus dir: ${corpusDir}`);
  }

  const py = process.env.PYTHON || "python";
  const args = [runnerPath, "--dir", corpusDir, "--variant", VARIANT, "--warmup", "1", "--json"];
  if (LIMIT > 0) {
    args.push("--limit", String(LIMIT));
  }

  const child = spawn(py, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += String(d);
  });
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    throw new Error(`RapidOCR runner failed (code=${code})\n${stderr.trim()}`);
  }

  const rows: any[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const rows = await runPythonRunner();
  console.log(`RapidOCR Riven Benchmark (${rows.length} rows) variant=${VARIANT}`);
  console.log("═".repeat(72));

  const ocrTimes: number[] = [];
  const totalTimes: number[] = [];

  let totalExpected = 0;
  let namesMatched = 0;
  let valuesMatched = 0;
  let signsMatched = 0;

  for (const row of rows) {
    const file = String(row.file || "");
    if (row.error) {
      console.log(`\n─── ${file} ───`);
      console.log(`  ERROR: ${row.error}${row.error_detail ? `: ${row.error_detail}` : ""}`);
      continue;
    }

    const ocrMs = Number(row.ocr_wall_ms || 0);
    const totalMs = Number(row.total_ms || 0);
    ocrTimes.push(ocrMs);
    totalTimes.push(totalMs);

    const rawText = String(row.text || "");
    const normText = normalizeRapidOcrText(rawText);
    const stats = parseRivenStats(normText);
    const score = scoreStatsCandidate(stats, normText);

    console.log(`\n─── ${file} ───`);
    console.log(
      `  OCR: ${ocrMs}ms | total: ${totalMs}ms | boxes=${row.boxes ?? 0} | crop=${row.crop ?? "?"} ${row.crop_shape ? `| cropPx=${row.crop_shape[0]}x${row.crop_shape[1]}` : ""}`,
    );
    if (Array.isArray(row.rapidocr_elapse_ms) && row.rapidocr_elapse_ms.length) {
      console.log(`  RapidOCR elapse (ms): ${row.rapidocr_elapse_ms.join(", ")}`);
    }
    console.log(`  Stats: ${formatStats(stats)}`);
    console.log(`  Score: ${score}`);

    const gt = GROUND_TRUTH[file];
    if (gt) {
      const acc = scoreAccuracy(stats, gt);
      totalExpected += acc.totalExpected;
      namesMatched += acc.namesMatched;
      valuesMatched += acc.valuesMatched;
      signsMatched += acc.signsMatched;
      console.log(
        `  Accuracy: names ${acc.namesMatched}/${acc.totalExpected}, values ${acc.valuesMatched}/${acc.totalExpected}, signs ${acc.signsMatched}/${acc.totalExpected}`,
      );
    } else {
      console.log("  Accuracy: (no ground truth)");
    }
  }

  console.log("\n" + "═".repeat(72));
  console.log("SUMMARY");
  console.log("═".repeat(72));
  if (ocrTimes.length) {
    const avgOcr = Math.round(ocrTimes.reduce((a, b) => a + b, 0) / ocrTimes.length);
    const avgTotal = Math.round(totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length);
    console.log(`Speed:`);
    console.log(
      `  OCR avg=${avgOcr}ms p50=${percentile(ocrTimes, 50)}ms p95=${percentile(ocrTimes, 95)}ms`,
    );
    console.log(
      `  Total avg=${avgTotal}ms p50=${percentile(totalTimes, 50)}ms p95=${percentile(totalTimes, 95)}ms`,
    );
  }
  if (totalExpected > 0) {
    console.log(`Accuracy (vs ground truth):`);
    console.log(
      `  names ${namesMatched}/${totalExpected} (${Math.round((namesMatched / totalExpected) * 100)}%) | ` +
        `values ${valuesMatched}/${totalExpected} (${Math.round((valuesMatched / totalExpected) * 100)}%) | ` +
        `signs ${signsMatched}/${totalExpected} (${Math.round((signsMatched / totalExpected) * 100)}%)`,
    );
  }
})().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
