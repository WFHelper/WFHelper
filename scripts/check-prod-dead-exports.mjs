#!/usr/bin/env node
/**
 * Finds exports whose only references live in test files.
 *
 * knip can't catch these: knip.json lists the test globs as `entry` (its
 * vitest plugin doesn't detect the worker subpackage layout), so a function
 * can rot in prod while staying "reachable" through a test import.
 *
 * Dumb token matching, no AST. A name showing up in a comment or string of a
 * prod file counts as a prod reference, and multi-line `export { ... } from`
 * blocks count as prod-used - both make the gate under-report, so it never
 * asks you to delete something that's actually live.
 *
 * Intentional test seams use the `...ForTest`/`...ForTesting` suffix or the
 * ALLOWLIST below. Exits 1 if anything else is test-only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// repo root, independent of invocation cwd
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Intentional test-only exports kept on purpose. Add with a one-line reason.
const ALLOWLIST = new Set([
  // Sole fuzzy-match regression coverage; no non-Detailed prod equivalent.
  "matchSingleRewardTextDetailed",
  // Test-isolation reset for module debug counters (no prod reset by design).
  "resetOrderBookDebugCounters",
  "resetOrderSummaryDebugState",
  // Only reset for a process-lifetime cache; used purely for test isolation.
  "clearOrderSummaryCache",
  // API parity with the worker-consumed worker*CacheKey / snapshot siblings.
  "workerOrdersCacheKey",
  // Test-isolation resets for in-process caches (parallel to clearOrderSummaryCache).
  "clearCache",
  "clearPriceCache",
  // Alias name inside `__test__` bag (the underlying constant is consumed in prod).
  "priceQueueFullError",
]);

// Where exports are *defined* (main production tree).
const DEF_DIRS = ["services", "ipc", "config", "src"];
const DEF_ROOT_FILES = [
  "main.ts",
  "preload.ts",
  "preload-overlay.ts",
  "preload-riven.ts",
  "preload-trade-notification.ts",
];
// Where a reference *counts* - full surface incl. worker package + renderer.
const USE_DIRS = ["services", "ipc", "config", "src", "renderer", "backend", "tests", "e2e"];

const isTestPath = (p) =>
  /\.(test|spec)\.[cm]?ts$/.test(p) ||
  p.includes(`${sep}tests${sep}`) ||
  p.includes(`${sep}e2e${sep}`) ||
  p.includes(`${sep}__tests__${sep}`) ||
  /backend[\\/]worker[\\/]test[\\/]/.test(p);

const SKIP_DIR = new Set(["node_modules", ".electron-build", "dist", ".git", "release", ".icon-mirror"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(full, out);
    } else if (/\.(c|m)?ts$|\.svelte$|\.[cm]?js$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectFiles(dirs, rootFiles = []) {
  const files = [];
  for (const d of dirs) {
    const abs = join(ROOT, d);
    try {
      if (statSync(abs).isDirectory()) walk(abs, files);
    } catch {
      /* dir absent - skip */
    }
  }
  for (const f of rootFiles) {
    try {
      statSync(join(ROOT, f));
      files.push(join(ROOT, f));
    } catch {
      /* absent */
    }
  }
  return files;
}

const EXPORT_RE =
  /^\s*export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT_LINE_RE = /^\s*export\s+(?:type\s+)?\{/;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const TEST_BAG_OPEN_RE = /^\s*export\s+const\s+__test__\s*=\s*\{/;

// Map every exported symbol -> its defining file. Also pull members out of
// `export const __test__ = { ... }` bags so they get tracked individually,
// and remember each bag's line range so refs inside it don't count as
// prod use of the wrapped helper.
const defs = new Map(); // name -> { file, line }
const defAtLine = new Map(); // `${file}\0${line}` -> name
const testBagRanges = new Map(); // file -> Array<[startLine, endLine]>
for (const file of collectFiles(DEF_DIRS, DEF_ROOT_FILES)) {
  if (isTestPath(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(EXPORT_RE);
    if (m && !defs.has(m[1])) {
      defs.set(m[1], { file, line: i + 1 });
      defAtLine.set(`${file}\0${i + 1}`, m[1]);
    }
  }
  // Find `export const __test__ = { ... }` bag bodies via brace counting.
  for (let i = 0; i < lines.length; i++) {
    if (!TEST_BAG_OPEN_RE.test(lines[i])) continue;
    let depth = 0;
    let started = false;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      if (started && depth === 0) break;
    }
    if (!testBagRanges.has(file)) testBagRanges.set(file, []);
    testBagRanges.get(file).push([i, j]);
    // Pull member names. Bags use shorthand (`{ foo, bar }`) or `key: value`
    // - accept identifier tokens, ignore literal values (kept simple: any
    // identifier that resolves to a local declaration in this file counts).
    const body = lines.slice(i, j + 1).join("\n");
    const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
    const memberNames = new Set(inner.match(IDENT_RE) || []);
    for (const name of memberNames) {
      if (defs.has(name)) continue;
      // Locate the actual declaration line in this same file so the gate
      // can later skip the def occurrence the same way it does for normal
      // exports. Falls back to the bag line if no declaration is found.
      const declRe = new RegExp(
        `^\\s*(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`,
      );
      let declLine = i;
      for (let k = 0; k < lines.length; k++) {
        if (declRe.test(lines[k])) { declLine = k; break; }
      }
      defs.set(name, { file, line: declLine + 1 });
      defAtLine.set(`${file}\0${declLine + 1}`, name);
    }
  }
}

// Single pass over the full surface: tokenize each line once, tally each
// exported identifier into the prod or test bucket.
const prodRefs = new Map();
const testRefs = new Map();
for (const file of collectFiles(USE_DIRS, DEF_ROOT_FILES)) {
  const isTest = isTestPath(file);
  const bucket = isTest ? testRefs : prodRefs;
  // In prod files, occurrences inside `__test__ = { ... }` bags don't count as
  // real production use - they exist solely to expose the helper to tests.
  const skipRanges = !isTest ? testBagRanges.get(file) : null;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (skipRanges && skipRanges.some(([a, b]) => i >= a && i <= b)) continue;
    const line = lines[i];
    // Skip pure re-export aggregation lines (`export { X } from "..."`).
    if (REEXPORT_LINE_RE.test(line) && line.includes("from")) continue;
    const idents = line.match(IDENT_RE);
    if (!idents) continue;
    const definedHere = defAtLine.get(`${file}\0${i + 1}`);
    for (const tok of idents) {
      if (!defs.has(tok)) continue; // only track exported symbols
      if (tok === definedHere) continue; // skip the definition itself
      bucket.set(tok, (bucket.get(tok) || 0) + 1);
    }
  }
}

// A finding = referenced by tests, never by production, not an allowed seam.
const findings = [];
for (const [name, def] of defs) {
  if (/(ForTest|ForTesting)$/.test(name)) continue;
  if (ALLOWLIST.has(name)) continue;
  if ((testRefs.get(name) || 0) > 0 && (prodRefs.get(name) || 0) === 0) {
    findings.push({
      name,
      file: def.file.replace(ROOT + sep, ""),
      line: def.line,
      testRefs: testRefs.get(name),
    });
  }
}

if (findings.length === 0) {
  console.log("check-prod-dead-exports: OK (no production-dead test-only exports)");
  process.exit(0);
}

console.error(
  `\ncheck-prod-dead-exports: ${findings.length} export(s) referenced ONLY by tests:\n`,
);
for (const f of findings.sort((a, b) => a.name.localeCompare(b.name))) {
  console.error(`  ${f.name}  -  ${f.file}:${f.line}  (test refs: ${f.testRefs})`);
}
console.error(
  "\nRemove the dead export (+ its orphaned test), or, if it is an intentional\n" +
    "test seam, rename it `...ForTest` or add it to ALLOWLIST with a reason.\n",
);
process.exit(1);
