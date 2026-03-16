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
// TradingPost.lua emits a line like:
//   Script [Info]: TradingPost.lua: Initiating Trade With: <username>.
// We capture the username at the end, stripping a trailing period if present.
const TRADE_PARTNER_PATTERN = /TradingPost\.lua.*?[Tt]rade.*?[Ww]ith[: ]+([A-Za-z0-9_\-.]+)\.?\s*$/i;

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
// File-based poll is a safety net — DBWIN delivers lines with zero-latency.
// 500 ms keeps the backup responsive while cutting CPU wake-ups by 5×.
const POLL_INTERVAL_MS = 500;
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
let tradePartnerCallback: ((username: string) => void) | null = null;
let tradeConfirmedCallback: ((trade: ParsedLogTrade) => void) | null = null;

export const RIVEN_PATTERNS = {
  sessionOpen: /Sys \[Info\]: Created \/Lotus\/Interface\/OmegaRerollSelection\.swf/,
  // NpcManager::ClearAgents fires when the player closes / leaves the riven
  // cycling screen.  Used to close the overlay.
  sessionClose: /NpcManager::ClearAgents\(\) ReadyToCreateAgents = false/,
  // Fires when a player clicks a riven mod link in chat — opens a read-only preview.
  chatRivenView: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis 1/,
  // Fires when the chat riven preview dialog closes.
  chatRivenClose: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis 0/,
  // English-only patterns — used to extract weapon name and kuva cost when available.
  // Non-English games fall back to the generic dialog detection below.
  cycleConfirmEn:
    /Dialog::CreateOkCancel\(description=Are you sure you want to cycle (.+?) for ([\d,. ]+)\?/,
  choiceConfirmEn: /Dialog::CreateOkCancel\(description=Cycle Riven into current selection\?/,
  // Language-independent: matches ANY CreateOkCancel dialog that has real buttons.
  // Excludes non-interactive dialogs like NavBar_QuickMatchPleaseWait (leftItem=nil).
  genericDialog: /Dialog::CreateOkCancel\(/,
  genericDialogNonInteractive: /leftItem=nil/,
  // Captures the result code: 4 = confirm (MENU_SELECT), 5 = cancel (MENU_CANCEL)
  sendResult: /Dialog\.lua:\s*Dialog::SendResult\((\d+)\)/,
} as const;

let rivenSessionOpenCallback: (() => void) | null = null;
let rivenSessionCloseCallback: (() => void) | null = null;
let rivenChatViewCallback: (() => void) | null = null;
let _rivenChatViewActive = false;
let rivenRollPendingCallback: ((weapon: string, kuvaPerRoll: number) => void) | null = null;
let rivenRollConfirmedCallback: (() => void) | null = null;
let rivenChoiceConfirmedCallback: (() => void) | null = null;

// Tracks which riven dialog is currently pending so SendResult can be dispatched correctly.
// "roll_confirm" = "Are you sure you want to cycle X for Y?" dialog
// "choice"       = "Cycle Riven into current selection?" dialog
let _rivenPendingDialog: "roll_confirm" | "choice" | null = null;
let _rivenSessionActive = false;
let _rivenSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Users may browse their riven inventory for a while before rolling — 2 min
// gives enough headroom. Timer is refreshed on every riven-related event.
const RIVEN_SESSION_IDLE_TIMEOUT_MS = 120_000;

// Language-independent dialog tracking: the riven rolling flow is strictly alternating
// CreateOkCancel (cycle) → SendResult → CreateOkCancel (choice) → SendResult → repeat.
// This lets us detect riven dialogs in ANY language without relying on the description text.
let _rivenNextDialog: "cycle" | "choice" = "cycle";

// Cooldown to prevent duplicate fires from DBWIN + file poll delivering the same line.
// Both sources feed handleLine() on the main thread, but the second source delivers the
// same sequence ~0-5s later, causing the full state machine to re-trigger.
let _lastRivenSendResultAt = 0;
const RIVEN_SEND_RESULT_COOLDOWN_MS = 400;

// Cooldown for generic dialog detection.  After a SendResult fires, other game
// dialogs (matchmaking, squad, etc.) can appear in the same EE.log batch.  These
// would be misidentified as riven dialogs by the generic fallback.  A short cooldown
// prevents the generic path from matching immediately after a SendResult.
let _lastRivenGenericDialogAt = 0;
const RIVEN_GENERIC_DIALOG_COOLDOWN_MS = 600;

// Cooldown for the English choice dialog pattern.  DBWIN sometimes delivers the
// same OutputDebugString line several times in a single burst (Warframe writes the
// dialog description multiple times as it builds the UI).  Without a cooldown the
// log fills with repeated "Riven choice dialog detected" messages.
// The state updates (_rivenPendingDialog, _rivenSessionActive) still happen on
// every match so the state machine stays correct; only the log line is throttled.
let _lastRivenChoiceDialogAt = 0;
const RIVEN_CHOICE_DIALOG_COOLDOWN_MS = 2000;

// Cooldown for session-open detection.  DBWIN delivers the OmegaRerollSelection.swf
// line instantly, and the file poll re-delivers it seconds later.  Without this,
// `onRivenSessionOpen` fires twice — wiping stats from the first scan.
let _lastRivenSessionOpenAt = 0;
const RIVEN_SESSION_OPEN_COOLDOWN_MS = 15_000;

// When DBWIN is active, riven events arrive in real-time via the worker thread.
// The EE.log file poll re-delivers the exact same lines 0–5 s later.  If we
// process the stale file-poll copies, the dialog state machine mis-advances:
// e.g. a SendResult(4) for the ROLL confirmation arrives after the choice dialog
// has already set _rivenPendingDialog to "choice", causing a false
// onRivenChoiceConfirmed that resets both overlay panels.
// Fix: when DBWIN is active, skip ALL riven pattern processing from file-poll
// lines.  Non-riven events (rewards, relic picker, trades) still use both sources.
let _dbwinActive = false;

// ── Trade dialog multi-line buffer ────────────────────────────────────────────

export interface ParsedLogTradeItem {
  displayName: string;
  count: number;
  direction: "given" | "received";
}

export interface ParsedLogTrade {
  partner: string;
  platChange: number;
  type: "sale" | "purchase";
  items: ParsedLogTradeItem[];
}

let _tradeDialogBuffer: string[] | null = null;
const TRADE_DIALOG_START = "Are you sure you want to accept this trade?";
const TRADE_SUCCESS = "The trade was successful!";
const TRADE_DIALOG_TIMEOUT_MS = 60_000;
let _tradeDialogStartAt = 0;

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
        _dbwinActive = true;
        log.log("[EELog/DBWIN] OutputDebugString listener ready (alreadyExists:", m.alreadyExists, ")");
        break;
      case "line":
        if (m.msg) handleLine(m.msg, "dbwin");
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
    _dbwinActive = false;
  });

  dbwinWorker.on("exit", () => {
    dbwinWorker = null;
    _dbwinActive = false;
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

function resetRivenIdleTimer(): void {
  if (_rivenSessionIdleTimer) clearTimeout(_rivenSessionIdleTimer);
  _rivenSessionIdleTimer = setTimeout(() => {
    _rivenSessionIdleTimer = null;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    _rivenSessionActive = false;
    log.log("[EELog] Riven session idle timeout — resetting");
  }, RIVEN_SESSION_IDLE_TIMEOUT_MS);
}

function handleLine(line: string, source: "dbwin" | "file" = "file"): void {
  if (!line) return;

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("reward");
  }

  if (RELIC_PICKER_PATTERNS.some((pattern) => pattern.test(line))) {
    log.log("[EELog] Relic picker match line:", String(line).slice(0, 220));
    scheduleTrigger("relic_picker");
  }

  const tradeMatch = TRADE_PARTNER_PATTERN.exec(line);
  if (tradeMatch && tradeMatch[1]) {
    const username = tradeMatch[1].replace(/\.$/, "").trim();
    if (username && typeof tradePartnerCallback === "function") {
      log.log("[EELog] Trade partner detected:", username);
      tradePartnerCallback(username);
    }
  }

  // ── Trade dialog buffering ─────────────────────────────────────────────────
  if (line.includes(TRADE_DIALOG_START)) {
    _tradeDialogBuffer = [line];
    _tradeDialogStartAt = Date.now();
  } else if (_tradeDialogBuffer !== null) {
    // Timeout guard — abandon if dialog stays open too long
    if (Date.now() - _tradeDialogStartAt > TRADE_DIALOG_TIMEOUT_MS) {
      _tradeDialogBuffer = null;
    } else {
      _tradeDialogBuffer.push(line);
    }
  }

  if (line.includes(TRADE_SUCCESS) && _tradeDialogBuffer !== null) {
    const parsed = _parseTradeDialog(_tradeDialogBuffer);
    _tradeDialogBuffer = null;
    if (parsed && typeof tradeConfirmedCallback === "function") {
      log.log(`[EELog] Trade confirmed: ${parsed.type} ${parsed.platChange}p with ${parsed.partner}, ${parsed.items.length} item(s)`);
      tradeConfirmedCallback(parsed);
    }
  }

  // ── Riven rolling session ──────────────────────────────────────────────────
  // Riven patterns MUST be evaluated before RELIC_PICKER_CLOSE_PATTERNS because
  // both share the same Dialog::SendResult regex. When a riven dialog is pending
  // or a riven session is active ALL SendResult events belong to the riven flow.
  //
  // When DBWIN is active, skip riven processing from file-poll lines.  DBWIN
  // delivers riven events instantly; the file poll re-delivers the same lines
  // 0–5 s later — by which time the dialog state machine has already advanced,
  // causing stale events to mis-fire callbacks (e.g. a roll-confirm SendResult
  // arriving after _rivenPendingDialog has changed to "choice").
  const skipRivenFromFilePoll = _dbwinActive && source === "file";

  if (!skipRivenFromFilePoll && RIVEN_PATTERNS.sessionOpen.test(line)) {
    const now = Date.now();
    if (now - _lastRivenSessionOpenAt >= RIVEN_SESSION_OPEN_COOLDOWN_MS) {
      _lastRivenSessionOpenAt = now;
      _rivenSessionActive = true;
      _rivenChatViewActive = false; // rolling supersedes chat view
      _rivenNextDialog = "cycle";
      _rivenPendingDialog = null;
      resetRivenIdleTimer();
      log.log("[EELog] Riven rolling screen opened -> dispatching session open");
      if (typeof rivenSessionOpenCallback === "function") rivenSessionOpenCallback();
    } else {
      log.log("[EELog] Riven session open suppressed (cooldown)");
    }
  }

  // NpcManager::ClearAgents fires when the player leaves the riven cycling screen.
  // Only dispatch if a riven session is currently active — this line also fires
  // during other game flows, so we must not false-trigger.
  if (!skipRivenFromFilePoll && _rivenSessionActive && RIVEN_PATTERNS.sessionClose.test(line)) {
    log.log("[EELog] Riven session close (ClearAgents) -> dispatching overlay close");
    _rivenSessionActive = false;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    if (_rivenSessionIdleTimer) {
      clearTimeout(_rivenSessionIdleTimer);
      _rivenSessionIdleTimer = null;
    }
    if (typeof rivenSessionCloseCallback === "function") rivenSessionCloseCallback();
  }

  // ── Riven chat-link view ──────────────────────────────────────────────────
  // Clicking a riven mod link in chat opens a read-only preview dialog.
  // Show only the left overlay panel (no rolling, no right panel).
  // Only fire when NOT already in a rolling session — the rolling screen
  // also triggers HudVis internally, and we don't want to override it.
  if (!skipRivenFromFilePoll && !_rivenSessionActive && RIVEN_PATTERNS.chatRivenView.test(line)) {
    _rivenChatViewActive = true;
    log.log("[EELog] Riven chat-link view detected -> dispatching chat view");
    if (typeof rivenChatViewCallback === "function") rivenChatViewCallback();
  }

  // Close the chat riven preview — HudVis 0 fires when the dialog is dismissed.
  if (!skipRivenFromFilePoll && _rivenChatViewActive && RIVEN_PATTERNS.chatRivenClose.test(line)) {
    _rivenChatViewActive = false;
    log.log("[EELog] Riven chat-link view closed -> dispatching session close");
    if (typeof rivenSessionCloseCallback === "function") rivenSessionCloseCallback();
  }

  // ── Dialog detection (two layers) ─────────────────────────────────────────
  // Layer 1: English-specific patterns — work REGARDLESS of _rivenSessionActive
  // because the description text is unique enough to identify riven dialogs.
  // They also re-activate the session if the idle timer had expired.
  //
  // Layer 2 (fallback): Generic Dialog::CreateOkCancel during an active session —
  // uses the _rivenNextDialog toggle to determine cycle vs choice when the
  // description text can't be matched (non-English game language).
  let rivenDialogHandled = skipRivenFromFilePoll; // skip all dialog detection from file poll

  const rivenCycleMatch = !skipRivenFromFilePoll ? line.match(RIVEN_PATTERNS.cycleConfirmEn) : null;
  if (rivenCycleMatch) {
    rivenDialogHandled = true;
    _rivenSessionActive = true;
    resetRivenIdleTimer();
    _rivenPendingDialog = "roll_confirm";
    const weapon = rivenCycleMatch[1].trim();
    // Kuva costs are always integers; strip all locale thousands separators (., ,, space)
    const cost = parseInt(rivenCycleMatch[2].replace(/[,. ]/g, ""), 10) || 0;
    log.log(`[EELog] Riven roll pending: weapon=${weapon}, cost=${cost}`);
    if (typeof rivenRollPendingCallback === "function") rivenRollPendingCallback(weapon, cost);
  }

  if (!rivenDialogHandled && !skipRivenFromFilePoll && RIVEN_PATTERNS.choiceConfirmEn.test(line)) {
    rivenDialogHandled = true;
    _rivenSessionActive = true;
    resetRivenIdleTimer();
    _rivenPendingDialog = "choice";
    // Only log once per burst — DBWIN can deliver the same dialog line several
    // times in rapid succession; the state updates above are harmless but the
    // repeated log messages are confusing.
    const now = Date.now();
    if (now - _lastRivenChoiceDialogAt >= RIVEN_CHOICE_DIALOG_COOLDOWN_MS) {
      _lastRivenChoiceDialogAt = now;
      log.log("[EELog] Riven choice dialog detected (English)");
    }
  }

  // Layer 2: generic fallback — only during an active session (within idle window).
  // Skip non-interactive dialogs (NavBar_QuickMatchPleaseWait has leftItem=nil).
  // Also skip if a SendResult just fired — other game dialogs (matchmaking, squad)
  // can appear in the same log batch and would be misidentified as riven dialogs.
  if (
    !rivenDialogHandled &&
    _rivenSessionActive &&
    _rivenPendingDialog === null &&
    Date.now() - _lastRivenSendResultAt >= RIVEN_GENERIC_DIALOG_COOLDOWN_MS &&
    RIVEN_PATTERNS.genericDialog.test(line) &&
    !RIVEN_PATTERNS.genericDialogNonInteractive.test(line)
  ) {
    resetRivenIdleTimer();
    _lastRivenGenericDialogAt = Date.now();
    if (_rivenNextDialog === "cycle") {
      _rivenPendingDialog = "roll_confirm";
      log.log("[EELog] Riven roll pending (generic dialog)");
      if (typeof rivenRollPendingCallback === "function") rivenRollPendingCallback("", 0);
    } else {
      _rivenPendingDialog = "choice";
      log.log("[EELog] Riven choice dialog detected (generic)");
    }
  }

  // Track whether SendResult was consumed by the riven flow
  let sendResultConsumedByRiven = false;

  // Consume SendResult when either a riven dialog is pending (from English or generic
  // detection) OR the riven session is active (prevents stale SendResult from leaking
  // to the relic picker close handler).
  //
  // Result codes:  4 = confirm (MENU_SELECT)  →  dispatch callback + advance state
  //                5 = cancel  (MENU_CANCEL)  →  clear pending, do NOT dispatch
  const sendResultMatch = line.match(RIVEN_PATTERNS.sendResult);
  // Even when skipping riven processing from file poll, we must still mark
  // SendResult as consumed so it doesn't leak to the relic picker close handler.
  if (sendResultMatch && _rivenSessionActive && skipRivenFromFilePoll) {
    sendResultConsumedByRiven = true;
  }
  if (sendResultMatch && !skipRivenFromFilePoll && (_rivenPendingDialog !== null || _rivenSessionActive)) {
    sendResultConsumedByRiven = true;
    if (_rivenSessionActive) resetRivenIdleTimer();
    const resultCode = sendResultMatch[1];

    if (_rivenPendingDialog !== null) {
      if (resultCode === "4") {
        // CONFIRM — dispatch and advance the dialog toggle
        const now = Date.now();
        // Cooldown prevents DBWIN + file poll from double-firing the same callback.
        if (now - _lastRivenSendResultAt >= RIVEN_SEND_RESULT_COOLDOWN_MS) {
          _lastRivenSendResultAt = now;
          if (_rivenPendingDialog === "roll_confirm") {
            _rivenNextDialog = "choice";
            log.log("[EELog] Riven roll confirmed -> dispatching OCR trigger");
            if (typeof rivenRollConfirmedCallback === "function") rivenRollConfirmedCallback();
          } else if (_rivenPendingDialog === "choice") {
            _rivenNextDialog = "cycle";
            log.log("[EELog] Riven choice confirmed -> dispatching choice scan");
            if (typeof rivenChoiceConfirmedCallback === "function") rivenChoiceConfirmedCallback();
          }
        }
      } else {
        // CANCEL (5) or other — clear pending without dispatching or advancing.
        // The user cancelled the dialog, so we stay in the same state.
        log.log(`[EELog] Riven dialog cancelled (SendResult ${resultCode})`);
      }
      _rivenPendingDialog = null;
    }
  }

  // ── Relic picker close detection ────────────────────────────────────────────
  // Only fire the relic close callback if SendResult was NOT consumed by riven
  // AND no riven session is active (any SendResult during a riven session belongs
  // to the riven flow, even when _rivenPendingDialog is null between steps).
  if (!sendResultConsumedByRiven && !_rivenSessionActive && RELIC_PICKER_CLOSE_PATTERNS.some((pattern) => pattern.test(line))) {
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

/**
 * Parse the buffered trade confirmation dialog lines into a structured trade.
 * Format:
 *   "You are offering:\n\n<items>\n\nand will receive from <partner> the following:\n\n<items>"
 */
function _parseTradeDialog(lines: string[]): ParsedLogTrade | null {
  const text = lines.join("\n");

  // Extract the description between the trigger text and the leftItem suffix
  const descStart = text.indexOf("You are offering:");
  if (descStart < 0) return null;
  const desc = text.slice(descStart);

  // Split on the "and will receive from <partner> the following:" divider
  const receiveMatch = desc.match(/and will receive from\s+(.+?)\s+the following:/i);
  if (!receiveMatch) return null;
  const partner = receiveMatch[1].trim();

  const dividerIdx = desc.indexOf(receiveMatch[0]);
  const offeringBlock = desc.slice("You are offering:".length, dividerIdx);
  const receivingBlock = desc.slice(dividerIdx + receiveMatch[0].length);

  function parseItemBlock(block: string): { items: ParsedLogTradeItem[]; plat: number } {
    let plat = 0;
    const counts = new Map<string, number>();
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // Stop if we hit the closing part of Dialog args
      if (line.startsWith("leftItem=") || line.startsWith("rightItem=")) break;
      // Remove trailing comma from last item "..., leftItem=..."
      const cleaned = line.replace(/,\s*leftItem=.*$/i, "").trim();
      if (!cleaned) continue;

      const platMatch = cleaned.match(/^Platinum\s+x\s+(\d+)$/i);
      if (platMatch) {
        plat += parseInt(platMatch[1], 10);
        continue;
      }
      counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
    }
    const items: ParsedLogTradeItem[] = [];
    for (const [name, cnt] of counts) {
      items.push({ displayName: name, count: cnt, direction: "given" });
    }
    return { items, plat };
  }

  const offered = parseItemBlock(offeringBlock);
  const received = parseItemBlock(receivingBlock);

  // Determine trade type and plat
  const platGained = received.plat;
  const platSpent = offered.plat;
  const isSale = platGained > 0;
  const platChange = isSale ? platGained : platSpent;

  // Set directions
  for (const item of offered.items) item.direction = "given";
  for (const item of received.items) item.direction = "received";

  return {
    partner,
    platChange,
    type: isSale ? "sale" : "purchase",
    items: [...offered.items, ...received.items],
  };
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
  onTradingPartner?: ((username: string) => void) | null;
  onTradeConfirmed?: ((trade: ParsedLogTrade) => void) | null;
  onRivenSessionOpen?: (() => void) | null;
  onRivenSessionClose?: (() => void) | null;
  onRivenRollPending?: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed?: (() => void) | null;
  onRivenChoiceConfirmed?: (() => void) | null;
  onRivenChatView?: (() => void) | null;
}

function normalizeHandlers(
  handlers: (() => void) | EeLogHandlers | null | undefined,
): {
  onRewardTrigger: (() => void) | null;
  onRelicSelectionOpen: (() => void) | null;
  onRelicSelectionClose: (() => void) | null;
  onTradingPartner: ((username: string) => void) | null;
  onTradeConfirmed: ((trade: ParsedLogTrade) => void) | null;
  onRivenSessionOpen: (() => void) | null;
  onRivenSessionClose: (() => void) | null;
  onRivenRollPending: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed: (() => void) | null;
  onRivenChoiceConfirmed: (() => void) | null;
  onRivenChatView: (() => void) | null;
} {
  if (typeof handlers === "function") {
    return {
      onRewardTrigger: handlers,
      onRelicSelectionOpen: null,
      onRelicSelectionClose: null,
      onTradingPartner: null,
      onTradeConfirmed: null,
      onRivenSessionOpen: null,
      onRivenSessionClose: null,
      onRivenRollPending: null,
      onRivenRollConfirmed: null,
      onRivenChoiceConfirmed: null,
      onRivenChatView: null,
    };
  }

  if (!handlers || typeof handlers !== "object") {
    return {
      onRewardTrigger: null,
      onRelicSelectionOpen: null,
      onRelicSelectionClose: null,
      onTradingPartner: null,
      onTradeConfirmed: null,
      onRivenSessionOpen: null,
      onRivenSessionClose: null,
      onRivenRollPending: null,
      onRivenRollConfirmed: null,
      onRivenChoiceConfirmed: null,
      onRivenChatView: null,
    };
  }

  return {
    onRewardTrigger:
      typeof handlers.onRewardTrigger === "function" ? handlers.onRewardTrigger : null,
    onRelicSelectionOpen:
      typeof handlers.onRelicSelectionOpen === "function" ? handlers.onRelicSelectionOpen : null,
    onRelicSelectionClose:
      typeof handlers.onRelicSelectionClose === "function" ? handlers.onRelicSelectionClose : null,
    onTradingPartner:
      typeof handlers.onTradingPartner === "function" ? handlers.onTradingPartner : null,
    onTradeConfirmed:
      typeof handlers.onTradeConfirmed === "function" ? handlers.onTradeConfirmed : null,
    onRivenSessionOpen:
      typeof handlers.onRivenSessionOpen === "function" ? handlers.onRivenSessionOpen : null,
    onRivenSessionClose:
      typeof handlers.onRivenSessionClose === "function" ? handlers.onRivenSessionClose : null,
    onRivenRollPending:
      typeof handlers.onRivenRollPending === "function" ? handlers.onRivenRollPending : null,
    onRivenRollConfirmed:
      typeof handlers.onRivenRollConfirmed === "function" ? handlers.onRivenRollConfirmed : null,
    onRivenChoiceConfirmed:
      typeof handlers.onRivenChoiceConfirmed === "function"
        ? handlers.onRivenChoiceConfirmed
        : null,
    onRivenChatView:
      typeof handlers.onRivenChatView === "function" ? handlers.onRivenChatView : null,
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
  tradePartnerCallback = normalized.onTradingPartner;
  tradeConfirmedCallback = normalized.onTradeConfirmed;
  rivenSessionOpenCallback = normalized.onRivenSessionOpen;
  rivenSessionCloseCallback = normalized.onRivenSessionClose;
  rivenRollPendingCallback = normalized.onRivenRollPending;
  rivenRollConfirmedCallback = normalized.onRivenRollConfirmed;
  rivenChoiceConfirmedCallback = normalized.onRivenChoiceConfirmed;
  rivenChatViewCallback = normalized.onRivenChatView;

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
  rivenSessionOpenCallback = null;
  rivenSessionCloseCallback = null;
  rivenRollPendingCallback = null;
  rivenRollConfirmedCallback = null;
  rivenChoiceConfirmedCallback = null;
  rivenChatViewCallback = null;
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenSessionActive = false;
  _rivenChatViewActive = false;
  _lastRivenSendResultAt = 0;
  _lastRivenGenericDialogAt = 0;
  _lastRivenChoiceDialogAt = 0;
  _lastRivenSessionOpenAt = 0;
  _dbwinActive = false;
  if (_rivenSessionIdleTimer) {
    clearTimeout(_rivenSessionIdleTimer);
    _rivenSessionIdleTimer = null;
  }
  lineRemainder = "";
}
