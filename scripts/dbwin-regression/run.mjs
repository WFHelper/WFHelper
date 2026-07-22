#!/usr/bin/env node
// Regression harness for the two v1.1.3 koffi bugs: the koffi.view memory-cage
// fatal (needs the real Electron host) and the BOOL-flag event flood (caught by
// the [N, 3N] delivered-count band). Windows-only, needs build:main first;
// unreliable if another DBWIN reader is active (DebugView, Overwolf, WFHelper).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MATCHING_SENDS = 8;
const READY_TIMEOUT_MS = 60_000;
const EMITTER_TIMEOUT_MS = 60_000;
const POST_EMIT_GRACE_MS = 2_000;
const SUMMARY_TIMEOUT_MS = 20_000;

function log(msg) {
  console.log(`[dbwin-regression] ${msg}`);
}

function fail(msg) {
  console.error(`[dbwin-regression] FAIL: ${msg}`);
  process.exitCode = 1;
  cleanup();
  process.exit(1);
}

if (process.platform !== "win32") {
  log("skip: Windows-only (DBWIN is a Win32 protocol)");
  process.exit(0);
}

const workerPath = path.join(repoRoot, ".electron-build", "services", "dbwinWorker.js");
if (!fs.existsSync(workerPath)) {
  fail(`worker not built at ${workerPath} - run "pnpm run build:main" first`);
}

const electronPath = require("electron"); // exe path when required from plain node
const koffiMain = require.resolve("koffi");
const hostPath = path.join(repoRoot, "scripts", "dbwin-regression", "host.cjs");
const emitterPath = path.join(repoRoot, "scripts", "dbwin-regression", "emitter.cjs");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-dbwin-"));
const decoyExe = path.join(tmpDir, "Warframe.x64.exe");
const stopFile = path.join(tmpDir, "stop.flag");
fs.copyFileSync(process.execPath, decoyExe);
log(`decoy: ${decoyExe}`);

let host = null;
let decoy = null;

function cleanup() {
  try {
    if (decoy && decoy.exitCode === null) decoy.kill();
  } catch {}
  try {
    if (host && host.exitCode === null) host.kill();
  } catch {}
  // The decoy exe can stay locked for a moment after kill - best effort.
  setTimeout(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }, 1000).unref();
}

const hostEvents = [];
let decoyDone = false;
let summary = null;

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const t = setInterval(() => {
      const v = predicate();
      if (v) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() > deadline) {
        clearInterval(t);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 100);
  });
}

function attachLineReader(child, onLine, prefix) {
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (line) {
        console.log(`${prefix} ${line}`);
        onLine(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.error(`${prefix}! ${s}`);
  });
}

async function main() {
  host = spawn(electronPath, [hostPath, workerPath, stopFile], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachLineReader(
    host,
    (line) => {
      if (!line.startsWith("DBWIN_HOST ")) return;
      try {
        const ev = JSON.parse(line.slice("DBWIN_HOST ".length));
        hostEvents.push(ev);
        if (ev.event === "summary") summary = ev;
      } catch {}
    },
    "[host]",
  );

  decoy = spawn(decoyExe, [emitterPath, koffiMain, String(MATCHING_SENDS)], {
    cwd: tmpDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachLineReader(
    decoy,
    (line) => {
      if (line.includes("EMITTER_DONE")) decoyDone = true;
      if (line.includes("EMITTER_TIMEOUT")) fail("emitter never saw the DBWIN reader");
    },
    "[decoy]",
  );
  decoy.on("exit", (code) => {
    if (!decoyDone && code !== 0) fail(`decoy exited early (code ${code})`);
  });
  host.on("exit", (code) => {
    if (!summary) fail(`electron host exited without a summary (code ${code}) - worker crash?`);
  });

  const ready = await waitFor(
    () => hostEvents.find((e) => e.event === "ready"),
    READY_TIMEOUT_MS,
    "worker ready",
  );
  log("worker ready");
  if (ready.alreadyExists) {
    log("WARNING: DBWIN_BUFFER already existed - another debug listener is running; counts may be off");
  }

  await waitFor(() => decoyDone, EMITTER_TIMEOUT_MS, "emitter done");
  log(`emitter done (${MATCHING_SENDS} matching sends), grace ${POST_EMIT_GRACE_MS}ms`);
  await new Promise((r) => setTimeout(r, POST_EMIT_GRACE_MS));

  fs.writeFileSync(stopFile, "stop");
  await waitFor(() => summary, SUMMARY_TIMEOUT_MS, "host summary");
  const hostExit = await waitFor(
    () => (host.exitCode !== null ? { code: host.exitCode } : null),
    SUMMARY_TIMEOUT_MS,
    "host exit",
  );

  // Assertions
  const problems = [];
  if (!summary.ready) problems.push("worker never posted ready");
  if (!summary.stopped) problems.push("worker did not post stopped after stop flag");
  if (summary.workerExit !== 0) problems.push(`worker thread exit code ${summary.workerExit}`);
  if (summary.errors.length > 0) problems.push(`worker errors: ${summary.errors.join("; ")}`);
  if (hostExit.code !== 0) problems.push(`electron host exit code ${hostExit.code}`);
  if (summary.lines < MATCHING_SENDS) {
    problems.push(`delivered ${summary.lines} lines, expected >= ${MATCHING_SENDS} (lost messages)`);
  }
  if (summary.lines > MATCHING_SENDS * 3) {
    problems.push(
      `delivered ${summary.lines} lines for ${MATCHING_SENDS} sends - re-delivery flood (BOOL/int32 regression?)`,
    );
  }
  if (summary.matching < MATCHING_SENDS) {
    problems.push(`only ${summary.matching}/${MATCHING_SENDS} deliveries matched the trade line`);
  }

  if (problems.length > 0) {
    fail(problems.join(" | "));
  }
  log(`PASS: ${summary.lines} lines delivered for ${MATCHING_SENDS} sends, clean stop, no crash`);
  cleanup();
  process.exit(0);
}

main().catch((e) => fail(e.message));
