#!/usr/bin/env node
/**
 * Production-dead export gate.
 *
 * knip can't catch exports that are only consumed by tests, because knip.json
 * lists the test globs as `entry` (required — its vitest plugin doesn't
 * auto-detect the worker subpackage layout). So a function can rot in prod
 * while staying "reachable" through a test import and never get flagged.
 *
 * This gate finds every symbol exported from the main production tree whose
 * ONLY references live in test files. Intentional test seams are excluded by
 * the `…ForTest` / `…ForTesting` naming convention or the ALLOWLIST below.
 *
 * Limitations (intentional — this is a textual identifier-token heuristic,
 * not an AST/type analysis):
 *  - A name appearing in a comment or string in a production file counts as a
 *    prod reference, so the gate UNDER-reports rather than over-reports — it
 *    never tells you to delete something that is actually live.
 *  - A symbol surfaced only through a multi-line `export { … } from` re-export
 *    block is treated as prod-used (the inner line is not recognised as a
 *    re-export). Same safe direction: a false negative, never a false delete.
 *
 * Exit 1 (fails CI) if any unexpected production-dead test-only export exists.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, derived from this file's location (robust to invocation cwd —
// matches the convention used by the other scripts/*.mjs).
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
// Where a reference *counts* — full surface incl. worker package + renderer.
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
      /* dir absent — skip */
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

// 1. Map every exported symbol → its defining file (production tree only),
//    and index def locations by "file\0line" so the single scan below can
//    cheaply skip the definition's own occurrence.
const defs = new Map(); // name -> { file, line }
const defAtLine = new Map(); // `${file}\0${line}` -> name
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
}

// 2. Single pass over the full surface: tokenize each line once, tally each
//    exported identifier into the prod or test bucket (O(total tokens), no
//    per-symbol regex).
const prodRefs = new Map();
const testRefs = new Map();
for (const file of collectFiles(USE_DIRS, DEF_ROOT_FILES)) {
  const bucket = isTestPath(file) ? testRefs : prodRefs;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
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

// 3. A finding = referenced by tests, never by production, not an allowed seam.
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
  console.error(`  ${f.name}  —  ${f.file}:${f.line}  (test refs: ${f.testRefs})`);
}
console.error(
  "\nRemove the dead export (+ its orphaned test), or, if it is an intentional\n" +
    "test seam, rename it `…ForTest` or add it to ALLOWLIST with a reason.\n",
);
process.exit(1);
