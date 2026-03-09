"use strict";

import fs from "node:fs";
import path from "node:path";
import { Worker } from "worker_threads";
import chokidar from "chokidar";
import { withScope } from "./logger";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

const log = withScope("eeLogMonitor");

export const EE_LOG_PATH: string | null = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log")
  : null;

const REWARD_TRIGGER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bPause countdown done\b/i,
  /\bGot rewards\b/i,
]);
// Primary: LoadingCompleteEnd fires when the relic-selection screen is fully rendered
// and interactive — confirmed by AlecaFrame as the correct trigger point.
// Fallback: PopulateInventoryGrid fires earlier in the load sequence; kept so that
// if DE renames the lua file the trigger still works (it re-fires after cooldown if
// LoadingCompleteEnd never arrives).
const RELIC_PICKER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bThemedProjectionManager\.lua:\s*LoadingCompleteEnd\b/i,
  /\bProjection[A-Za-z_]*\.lua:\s*LoadingCompleteEnd\b/i,
  /\bThemedProjectionManager\.lua:\s*PopulateInventoryGrid\b/i,
  /\bProjectionManager\.lua:\s*PopulateInventoryGrid\b/i,
  /\bProjection[A-Za-z_]*\.lua:\s*PopulateInventoryGrid\b/i,
]);
// Dialog::SendResult fires when the relic-selection dialog closes (ESC, confirm, cancel).
// RELIC_PICKER_CLOSE_MIN_GAP_MS: if SendResult fires within this window of the last open
// trigger it is from navigating TO the relic screen, not FROM it — ignore it.
// (AlecaFrame has the same guard: "Skipped relic close because it was too close to
// the recommendation start!")
const RELIC_PICKER_CLOSE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bDialog\.lua:\s*Dialog::SendResult\(\d+\)/i,
]);

const TRIGGER_DELAY_MS = 450;
const RELIC_TRIGGER_DELAY_MS = 120;
const REWARD_TRIGGER_COOLDOWN_MS = 2500;
// DBWIN fires at T=0 (instant); EE.log file flush can lag 0–5 s behind.
// With both sources active the file-based read would re-trigger the overlay
// seconds later unless the cooldown covers the full flush window.
// 8 s is safely larger than any observed EE.log flush delay, yet far smaller
// than the minimum realistic time between two consecutive fissure mission entries.
const RELIC_PICKER_COOLDOWN_MS = 8000;
const RELIC_PICKER_CLOSE_COOLDOWN_MS = 500;
// Minimum gap between the last open trigger and a close trigger being honoured.
// Prevents Dialog::SendResult from closing the overlay when it fires as part of
// the navigation flow that leads TO the relic selection screen.
const RELIC_PICKER_CLOSE_MIN_GAP_MS = 2000;
const POLL_INTERVAL_MS = 100;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LOOPS_PER_TICK = 8;
const TRUNCATION_CHECK_INTERVAL_MS = 2000;

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let lastSize = 0;
let lineRemainder = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollFd: number | null = null;
let pollReading = false;
let lastTruncationCheckAt = 0;
const pollBuffer = Buffer.alloc(MAX_READ_BYTES);

let rewardCallback: (() => void) | null = null;
let relicPickerCallback: (() => void) | null = null;
let relicPickerCloseCallback: (() => void) | null = null;

let pendingRewardTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRelicPickerTimer: ReturnType<typeof setTimeout> | null = null;
let lastRewardAt = 0;
let lastRelicPickerAt = 0;
let lastRelicPickerCloseAt = 0;

let dbwinWorker: Worker | null = null;
let dbwinStopBuffer: SharedArrayBuffer | null = null;
let dbwinStopTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingTimers(): void {
  if (pendingRewardTimer) {
    clearTimeout(pendingRewardTimer);
    pendingRewardTimer = null;
  }
  if (pendingRelicPickerTimer) {
    clearTimeout(pendingRelicPickerTimer);
    pendingRelicPickerTimer = null;
  }
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function closePollFd(): void {
  if (pollFd == null) return;
  try {
    fs.closeSync(pollFd);
  } catch {
    // ignore close errors
  }
  pollFd = null;
}

function pollReadNewBytes(): void {
  if (pollReading) return;
  if (!EE_LOG_PATH) return;

  pollReading = true;
  try {
    if (!fs.existsSync(EE_LOG_PATH)) return;

    const now = Date.now();
    if (now - lastTruncationCheckAt >= TRUNCATION_CHECK_INTERVAL_MS) {
      lastTruncationCheckAt = now;
      try {
        const size = fs.statSync(EE_LOG_PATH).size;
        if (size < lastSize) {
          closePollFd();
          lastSize = 0;
          lineRemainder = "";
        }
      } catch {
        // ignore stat errors; retry next tick
      }
    }

    if (pollFd == null) {
      pollFd = fs.openSync(EE_LOG_PATH, "r");
    }

    let loops = 0;
    while (loops < MAX_READ_LOOPS_PER_TICK) {
      const bytesRead = fs.readSync(pollFd, pollBuffer, 0, pollBuffer.length, lastSize);
      if (!bytesRead) break;

      lastSize += bytesRead;
      consumeChunk(pollBuffer.subarray(0, bytesRead).toString("utf8"));

      if (bytesRead < pollBuffer.length) break;
      loops += 1;
    }
  } catch (error) {
    closePollFd();
    log.error("[EELog] poll read error:", normalizeErrorMessage(error));
  } finally {
    pollReading = false;
  }
}

function scheduleTrigger(type: "reward" | "relic_picker"): void {
  const isReward = type === "reward";
  const now = Date.now();
  const lastAt = isReward ? lastRewardAt : lastRelicPickerAt;
  const cooldown = isReward ? REWARD_TRIGGER_COOLDOWN_MS : RELIC_PICKER_COOLDOWN_MS;

  if (now - lastAt < cooldown) return;

  if (isReward) {
    if (pendingRewardTimer) return;
    pendingRewardTimer = setTimeout(() => {
      pendingRewardTimer = null;
      lastRewardAt = Date.now();
      if (typeof rewardCallback === "function") {
        log.log("[EELog] Reward trigger detected -> dispatching reward scan");
        rewardCallback();
      }
    }, TRIGGER_DELAY_MS);
    return;
  }

  if (pendingRelicPickerTimer) return;
  pendingRelicPickerTimer = setTimeout(() => {
    pendingRelicPickerTimer = null;
    lastRelicPickerAt = Date.now();
    if (typeof relicPickerCallback === "function") {
      log.log("[EELog] Relic picker trigger detected -> dispatching recommendation overlay");
      relicPickerCallback();
    }
  }, RELIC_TRIGGER_DELAY_MS);
}

// ---------------------------------------------------------------------------
// OutputDebugString / DBWIN worker — parallel zero-latency log source
// ---------------------------------------------------------------------------
// Warframe (like all Win32 apps) calls OutputDebugString() for each log line.
// OutputDebugString writes the message into a shared-memory ring ("DBWIN_BUFFER")
// and signals "DBWIN_DATA_READY" — with NO file-system flush involved.
// Reading from that buffer gives us the line the instant Warframe emits it,
// bypassing whatever buffering delay exists between OutputDebugString and the
// EE.log flush to disk (which can be 0–5 s depending on Warframe's I/O scheduler).
//
// The Worker thread (dbwinWorker.ts) owns the Win32 handle lifetime and runs
// WaitForSingleObject in a tight loop without touching the main event loop.
// Lines it receives are fed into the same handleLine() path used by file polling,
// so the existing cooldown/dedup logic naturally absorbs duplicates from both sources.

interface DbwinWorkerMessage {
  type: "ready" | "line" | "error" | "stopped";
  pid?: number;
  msg?: string;
  alreadyExists?: boolean;
  message?: string;
}

function startDbwinWorker(): void {
  if (dbwinWorker) return;

  dbwinStopBuffer = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(dbwinStopBuffer), 0, 0);

  // dbwinWorker.ts compiles to the same output directory as this module
  dbwinWorker = new Worker(path.join(__dirname, "dbwinWorker.js"), {
    workerData: { stopBuffer: dbwinStopBuffer },
  });

  dbwinWorker.on("message", (m: DbwinWorkerMessage) => {
    switch (m.type) {
      case "ready":
        log.log("[EELog/DBWIN] OutputDebugString listener ready (alreadyExists:", m.alreadyExists, ")");
        break;
      case "line":
        if (m.msg) handleLine(m.msg);
        break;
      case "error":
        log.warn("[EELog/DBWIN] Worker error:", m.message);
        break;
      case "stopped":
        log.log("[EELog/DBWIN] Worker stopped cleanly");
        break;
    }
  });

  dbwinWorker.on("error", (err: Error) => {
    log.warn("[EELog/DBWIN] Worker threw:", String(err));
    dbwinWorker = null;
  });

  dbwinWorker.on("exit", () => {
    dbwinWorker = null;
  });
}

function stopDbwinWorker(): void {
  if (!dbwinWorker) return;

  // Signal the Worker to exit its WaitForSingleObject loop
  if (dbwinStopBuffer) {
    Atomics.store(new Int32Array(dbwinStopBuffer), 0, 1);
    dbwinStopBuffer = null;
  }

  // Force-terminate after 1.5 s in case the Worker is somehow stuck
  const w = dbwinWorker;
  dbwinWorker = null;

  dbwinStopTimer = setTimeout(() => {
    dbwinStopTimer = null;
    w.terminate().catch(() => {});
  }, 1500);

  w.once("exit", () => {
    if (dbwinStopTimer) {
      clearTimeout(dbwinStopTimer);
      dbwinStopTimer = null;
    }
  });
}

function handleLine(line: string): void {
  if (!line) return;

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("reward");
  }

  if (RELIC_PICKER_PATTERNS.some((pattern) => pattern.test(line))) {
    log.log("[EELog] Relic picker match line:", String(line).slice(0, 220));
    scheduleTrigger("relic_picker");
  }

  if (RELIC_PICKER_CLOSE_PATTERNS.some((pattern) => pattern.test(line))) {
    const now = Date.now();
    if (now - lastRelicPickerCloseAt >= RELIC_PICKER_CLOSE_COOLDOWN_MS) {
      lastRelicPickerCloseAt = now;
      if (now - lastRelicPickerAt < RELIC_PICKER_CLOSE_MIN_GAP_MS) {
        // Too close to the last open trigger — this SendResult is from navigating
        // TO the relic screen, not FROM it. Skip to avoid closing the overlay
        // immediately after it opens.
        log.log("[EELog] Relic picker close skipped — too close to last open trigger");
      } else if (typeof relicPickerCloseCallback === "function") {
        log.log("[EELog] Relic picker close detected -> dispatching overlay close");
        relicPickerCloseCallback();
      }
    }
  }
}

function consumeChunk(chunk: string): void {
  const merged = lineRemainder + String(chunk || "");
  const lines = merged.split(/\r?\n/);
  lineRemainder = lines.pop() || "";

  for (const line of lines) {
    handleLine(line);
  }
}

interface EeLogHandlers {
  onRewardTrigger?: (() => void) | null;
  onRelicSelectionOpen?: (() => void) | null;
  onRelicSelectionClose?: (() => void) | null;
}

function normalizeHandlers(
  handlers: (() => void) | EeLogHandlers | null | undefined,
): {
  onRewardTrigger: (() => void) | null;
  onRelicSelectionOpen: (() => void) | null;
  onRelicSelectionClose: (() => void) | null;
} {
  if (typeof handlers === "function") {
    return {
      onRewardTrigger: handlers,
      onRelicSelectionOpen: null,
      onRelicSelectionClose: null,
    };
  }

  if (!handlers || typeof handlers !== "object") {
    return {
      onRewardTrigger: null,
      onRelicSelectionOpen: null,
      onRelicSelectionClose: null,
    };
  }

  return {
    onRewardTrigger:
      typeof handlers.onRewardTrigger === "function" ? handlers.onRewardTrigger : null,
    onRelicSelectionOpen:
      typeof handlers.onRelicSelectionOpen === "function" ? handlers.onRelicSelectionOpen : null,
    onRelicSelectionClose:
      typeof handlers.onRelicSelectionClose === "function" ? handlers.onRelicSelectionClose : null,
  };
}

export function startWatching(
  handlers: (() => void) | EeLogHandlers | null | undefined,
): string | null {
  if (!EE_LOG_PATH) {
    log.warn("[EELog] LOCALAPPDATA not set; EE.log monitoring unavailable");
    return null;
  }
  if (!fs.existsSync(EE_LOG_PATH)) {
    log.warn("[EELog] EE.log not found at:", EE_LOG_PATH);
    return null;
  }

  const normalized = normalizeHandlers(handlers);
  rewardCallback = normalized.onRewardTrigger;
  relicPickerCallback = normalized.onRelicSelectionOpen;
  relicPickerCloseCallback = normalized.onRelicSelectionClose;

  clearPollTimer();
  closePollFd();

  try {
    lastSize = fs.statSync(EE_LOG_PATH).size;
  } catch {
    lastSize = 0;
  }
  lineRemainder = "";

  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(EE_LOG_PATH, {
    persistent: true,
    usePolling: false,
    awaitWriteFinish: false,
  });

  watcher.on("change", pollReadNewBytes);
  watcher.on("add", pollReadNewBytes);
  watcher.on("unlink", () => {
    closePollFd();
    lastSize = 0;
    lineRemainder = "";
  });

  pollTimer = setInterval(pollReadNewBytes, POLL_INTERVAL_MS);
  if (typeof (pollTimer as any)?.unref === "function") {
    (pollTimer as any).unref();
  }
  pollReadNewBytes();

  startDbwinWorker();

  log.log("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

export function stopWatching(): void {
  stopDbwinWorker();
  clearPendingTimers();
  clearPollTimer();
  closePollFd();

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  rewardCallback = null;
  relicPickerCallback = null;
  relicPickerCloseCallback = null;
  lineRemainder = "";
}
