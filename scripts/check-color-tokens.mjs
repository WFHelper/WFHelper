#!/usr/bin/env node
// Fails on raw colours in the renderer. Everything visible must resolve through a
// theme token so the inspector and per-view accents can repaint it.
// Usage: node scripts/check-color-tokens.mjs [--allow-existing]

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "color-token-baseline.json");
const EXTENSIONS = [".svelte", ".ts", ".css"];

// The token surface itself, plus the files that define it, must name real colours.
const EXCLUDED = ["src/styles/tokens.css", "src/app.css", "src/lib/theme/", "src/config/theme"];

const PREFIX =
  "text|bg|border|from|via|to|ring|fill|stroke|decoration|outline|shadow|accent|caret|divide|placeholder";
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const SHADE = "50|100|200|300|400|500|600|700|800|900|950";

const CLASS_RULES = [
  {
    id: "palette-utility",
    re: new RegExp(`\\b(?:${PREFIX})-(?:${PALETTE})-(?:${SHADE})(?:\\/\\d{1,3})?\\b`, "g"),
  },
  { id: "arbitrary-hex", re: new RegExp(`\\b(?:${PREFIX})-\\[#[0-9a-fA-F]{3,8}\\]`, "g") },
  {
    id: "arbitrary-color-fn",
    re: new RegExp(`\\b(?:${PREFIX})-\\[(?:rgb|rgba|hsl|hsla|oklch)\\(`, "g"),
  },
  { id: "black-white-alpha", re: /\bbg-(?:black|white)\/\d{1,3}\b/g },
];

const INLINE_RULES = [
  { id: "inline-hex", re: /#[0-9a-fA-F]{3,8}\b/g },
  { id: "inline-color-fn", re: /\b(?:rgb|rgba|hsl|hsla)\(/g },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function toPosix(path) {
  return path.split("\\").join("/");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/** Regions of a file where a raw colour literal counts: <style> blocks and style attributes. */
function inlineRegions(text, file) {
  if (file.endsWith(".css")) return [{ start: 0, text }];

  const regions = [];
  const styleBlock = /<style[^>]*>([\s\S]*?)<\/style>/g;
  for (let m = styleBlock.exec(text); m; m = styleBlock.exec(text)) {
    regions.push({ start: m.index + m[0].indexOf(m[1]), text: m[1] });
  }
  const styleAttr = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = styleAttr.exec(text); m; m = styleAttr.exec(text)) {
    const value = m[1] ?? m[2] ?? "";
    regions.push({ start: m.index + m[0].indexOf(value), text: value });
  }
  return regions;
}

function scanFile(file) {
  const rel = toPosix(relative(REPO_ROOT, file));
  if (EXCLUDED.some((prefix) => rel.startsWith(prefix))) return [];

  const text = readFileSync(file, "utf8");
  const findings = [];

  for (const rule of CLASS_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      findings.push({ file: rel, line: lineOf(text, m.index), rule: rule.id, match: m[0] });
    }
  }

  for (const region of inlineRegions(text, rel)) {
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = 0;
      for (let m = rule.re.exec(region.text); m; m = rule.re.exec(region.text)) {
        findings.push({
          file: rel,
          line: lineOf(text, region.start + m.index),
          rule: rule.id,
          match: m[0],
        });
      }
    }
  }

  return findings;
}

// Keyed by content, not line number, so unrelated edits above a finding do not
// turn it into a "new" one.
function countByKey(findings) {
  const counts = {};
  for (const f of findings) {
    const key = `${f.file}::${f.rule}::${f.match}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function main() {
  const writeBaseline = process.argv.includes("--allow-existing");
  const findings = walk(SCAN_ROOT).flatMap(scanFile);
  const counts = countByKey(findings);

  if (writeBaseline) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ generated: new Date().toISOString(), counts }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `Baseline written: ${findings.length} raw colour(s) in ${Object.keys(counts).length} spots.`,
    );
    return 0;
  }

  let baseline = {};
  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).counts ?? {};
    } catch {
      console.error(`Unreadable baseline at ${toPosix(relative(REPO_ROOT, BASELINE_PATH))}.`);
      return 1;
    }
  }

  const budget = { ...baseline };
  const fresh = [];
  for (const finding of findings) {
    const key = `${finding.file}::${finding.rule}::${finding.match}`;
    if (budget[key] > 0) {
      budget[key] -= 1;
      continue;
    }
    fresh.push(finding);
  }

  console.log(
    `Scanned ${toPosix(relative(REPO_ROOT, SCAN_ROOT))}: ${findings.length} raw colour(s).`,
  );

  if (fresh.length === 0) return 0;

  for (const finding of fresh) {
    console.error(`${finding.file}:${finding.line}  ${finding.rule}  ${finding.match}`);
  }
  console.error(`${fresh.length} raw colour(s) not covered by the baseline.`);
  console.error("Use a theme token, or re-run with --allow-existing to accept them.");
  return 1;
}

process.exit(main());
