"use strict";

import { withScope } from "./logger";

const log = withScope("rivenStateMachine");

// ── Riven log patterns ────────────────────────────────────────────────────────

export const RIVEN_PATTERNS = {
  sessionOpen: /Sys \[Info\]: Created \/Lotus\/Interface\/OmegaRerollSelection\.swf/,
  sessionClose: /NpcManager::ClearAgents\(\) ReadyToCreateAgents = false/,
  chatRivenView: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis 1/,
  chatRivenClose: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis 0/,
  cycleConfirmEn:
    /Dialog::CreateOkCancel\(description=Are you sure you want to cycle (.+?) for ([\d,. ]+)\?/,
  choiceConfirmEn: /Dialog::CreateOkCancel\(description=Cycle Riven into current selection\?/,
  genericDialog: /Dialog::CreateOkCancel\(/,
  genericDialogNonInteractive: /leftItem=nil/,
  sendResult: /Dialog\.lua:\s*Dialog::SendResult\((\d+)\)/,
  diaoramaSetup: /OmegaRerollSelection\.lua.*Diorama setup/i,
} as const;

// ── Callbacks ─────────────────────────────────────────────────────────────────

export interface RivenCallbacks {
  onRivenSessionOpen: (() => void) | null;
  onRivenSessionClose: (() => void) | null;
  onRivenChatView: (() => void) | null;
  onRivenRollPending: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed: (() => void) | null;
  onRivenDioramaSetup: (() => void) | null;
  onRivenChoiceConfirmed: (() => void) | null;
}

let _callbacks: RivenCallbacks = {
  onRivenSessionOpen: null,
  onRivenSessionClose: null,
  onRivenChatView: null,
  onRivenRollPending: null,
  onRivenRollConfirmed: null,
  onRivenDioramaSetup: null,
  onRivenChoiceConfirmed: null,
};

export function setRivenCallbacks(cbs: Partial<RivenCallbacks>): void {
  _callbacks = { ..._callbacks, ...cbs };
}

// ── State ─────────────────────────────────────────────────────────────────────

let _rivenPendingDialog: "roll_confirm" | "choice" | null = null;
let _rivenSessionActive = false;
let _rivenSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
const RIVEN_SESSION_IDLE_TIMEOUT_MS = 120_000;

let _rivenNextDialog: "cycle" | "choice" = "cycle";
let _rivenChatViewActive = false;

let _lastRivenSendResultAt = 0;
const RIVEN_SEND_RESULT_COOLDOWN_MS = 400;

let _lastRivenGenericDialogAt = 0;
const RIVEN_GENERIC_DIALOG_COOLDOWN_MS = 600;

let _lastRivenChoiceDialogAt = 0;
const RIVEN_CHOICE_DIALOG_COOLDOWN_MS = 2000;

let _lastRivenSessionOpenAt = 0;
const RIVEN_SESSION_OPEN_COOLDOWN_MS = 15_000;

let _lastRivenDioramaAt = 0;
const RIVEN_DIORAMA_DEDUP_MS = 2_000;

let _rivenForceEndedAt = 0;
const RIVEN_FORCE_END_COOLDOWN_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Core processing ───────────────────────────────────────────────────────────

/**
 * Process a single EE.log line for riven-related patterns.
 * Returns `true` if a SendResult was consumed by the riven flow (gates relic picker close).
 */
export function processRivenPatterns(
  line: string,
  source: "dbwin" | "file",
  dbwinActive: boolean,
): boolean {
  const skipRivenFromFilePoll = dbwinActive && source === "file";

  if (!skipRivenFromFilePoll && RIVEN_PATTERNS.sessionOpen.test(line)) {
    const now = Date.now();
    if (now - _lastRivenSessionOpenAt >= RIVEN_SESSION_OPEN_COOLDOWN_MS) {
      _lastRivenSessionOpenAt = now;
      _rivenSessionActive = true;
      _rivenChatViewActive = false;
      _rivenNextDialog = "cycle";
      _rivenPendingDialog = null;
      resetRivenIdleTimer();
      log.log("[EELog] Riven rolling screen opened -> dispatching session open");
      if (typeof _callbacks.onRivenSessionOpen === "function") _callbacks.onRivenSessionOpen();
    } else {
      log.log("[EELog] Riven session open suppressed (cooldown)");
    }
  }

  // Diorama ready: both cards are now displayed — trigger roll OCR immediately.
  // NOT gated by skipRivenFromFilePoll — OmegaRerollSelection.lua lines
  // are Lua script output that appears only in EE.log file, never via DBWIN.
  if (
    _rivenSessionActive &&
    RIVEN_PATTERNS.diaoramaSetup.test(line)
  ) {
    const now = Date.now();
    if (now - _lastRivenDioramaAt >= RIVEN_DIORAMA_DEDUP_MS) {
      _lastRivenDioramaAt = now;
      resetRivenIdleTimer();
      log.log("[EELog] Riven diorama ready -> dispatching diorama OCR trigger");
      if (typeof _callbacks.onRivenDioramaSetup === "function") _callbacks.onRivenDioramaSetup();
    }
  }

  if (!skipRivenFromFilePoll && _rivenSessionActive && RIVEN_PATTERNS.sessionClose.test(line)) {
    log.log("[EELog] Riven session close (ClearAgents) -> dispatching overlay close");
    _rivenSessionActive = false;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    if (_rivenSessionIdleTimer) {
      clearTimeout(_rivenSessionIdleTimer);
      _rivenSessionIdleTimer = null;
    }
    if (typeof _callbacks.onRivenSessionClose === "function") _callbacks.onRivenSessionClose();
  }

  // ── Riven chat-link view ──────────────────────────────────────────────────
  if (!_rivenSessionActive && RIVEN_PATTERNS.chatRivenView.test(line)) {
    _rivenChatViewActive = true;
    log.log("[EELog] Riven chat-link view detected -> dispatching chat view");
    if (typeof _callbacks.onRivenChatView === "function") _callbacks.onRivenChatView();
  }

  if (_rivenChatViewActive && RIVEN_PATTERNS.chatRivenClose.test(line)) {
    _rivenChatViewActive = false;
    log.log("[EELog] Riven chat-link view closed -> dispatching session close");
    if (typeof _callbacks.onRivenSessionClose === "function") _callbacks.onRivenSessionClose();
  }

  // ── Dialog detection (two layers) ─────────────────────────────────────────
  let rivenDialogHandled = skipRivenFromFilePoll;

  const rivenCycleMatch = !skipRivenFromFilePoll ? line.match(RIVEN_PATTERNS.cycleConfirmEn) : null;
  if (rivenCycleMatch && !(!_rivenSessionActive && Date.now() - _rivenForceEndedAt < RIVEN_FORCE_END_COOLDOWN_MS)) {
    rivenDialogHandled = true;
    _rivenSessionActive = true;
    resetRivenIdleTimer();
    _rivenPendingDialog = "roll_confirm";
    const weapon = rivenCycleMatch[1].trim();
    const cost = parseInt(rivenCycleMatch[2].replace(/[,. ]/g, ""), 10) || 0;
    log.log(`[EELog] Riven roll pending: weapon=${weapon}, cost=${cost}`);
    if (typeof _callbacks.onRivenRollPending === "function") _callbacks.onRivenRollPending(weapon, cost);
  }

  if (!rivenDialogHandled && !skipRivenFromFilePoll && RIVEN_PATTERNS.choiceConfirmEn.test(line) &&
      !(!_rivenSessionActive && Date.now() - _rivenForceEndedAt < RIVEN_FORCE_END_COOLDOWN_MS)) {
    rivenDialogHandled = true;
    _rivenSessionActive = true;
    resetRivenIdleTimer();
    _rivenPendingDialog = "choice";
    const now = Date.now();
    if (now - _lastRivenChoiceDialogAt >= RIVEN_CHOICE_DIALOG_COOLDOWN_MS) {
      _lastRivenChoiceDialogAt = now;
      log.log("[EELog] Riven choice dialog detected (English)");
    }
  }

  // Layer 2: generic fallback
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
      if (typeof _callbacks.onRivenRollPending === "function") _callbacks.onRivenRollPending("", 0);
    } else {
      _rivenPendingDialog = "choice";
      log.log("[EELog] Riven choice dialog detected (generic)");
    }
  }

  // ── SendResult handling ───────────────────────────────────────────────────
  let sendResultConsumedByRiven = false;

  const sendResultMatch = line.match(RIVEN_PATTERNS.sendResult);
  // Even when skipping riven from file poll, mark as consumed so it doesn't
  // leak to the relic picker close handler.
  if (sendResultMatch && _rivenSessionActive && skipRivenFromFilePoll) {
    sendResultConsumedByRiven = true;
  }
  if (sendResultMatch && !skipRivenFromFilePoll && (_rivenPendingDialog !== null || _rivenSessionActive)) {
    sendResultConsumedByRiven = true;
    if (_rivenSessionActive) resetRivenIdleTimer();
    const resultCode = sendResultMatch[1];

    if (_rivenPendingDialog !== null) {
      if (resultCode === "4") {
        const now = Date.now();
        if (now - _lastRivenSendResultAt >= RIVEN_SEND_RESULT_COOLDOWN_MS) {
          _lastRivenSendResultAt = now;
          if (_rivenPendingDialog === "roll_confirm") {
            _rivenNextDialog = "choice";
            log.log("[EELog] Riven roll confirmed -> dispatching OCR trigger");
            if (typeof _callbacks.onRivenRollConfirmed === "function") _callbacks.onRivenRollConfirmed();
          } else if (_rivenPendingDialog === "choice") {
            _rivenNextDialog = "cycle";
            log.log("[EELog] Riven choice confirmed -> dispatching choice scan");
            if (typeof _callbacks.onRivenChoiceConfirmed === "function") _callbacks.onRivenChoiceConfirmed();
          }
        }
      } else {
        log.log(`[EELog] Riven dialog cancelled (SendResult ${resultCode})`);
      }
      _rivenPendingDialog = null;
    }
  }

  return sendResultConsumedByRiven;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isRivenSessionActive(): boolean {
  return _rivenSessionActive;
}

export function forceEndRivenSession(): void {
  if (!_rivenSessionActive && !_rivenPendingDialog) return;
  _rivenSessionActive = false;
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenForceEndedAt = Date.now();
  if (_rivenSessionIdleTimer) {
    clearTimeout(_rivenSessionIdleTimer);
    _rivenSessionIdleTimer = null;
  }
  log.log("[EELog] Riven session force-ended (overlay dismissed externally)");
}

export function resetRivenState(): void {
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenSessionActive = false;
  _rivenChatViewActive = false;
  _lastRivenSendResultAt = 0;
  _lastRivenGenericDialogAt = 0;
  _lastRivenChoiceDialogAt = 0;
  _lastRivenSessionOpenAt = 0;
  if (_rivenSessionIdleTimer) {
    clearTimeout(_rivenSessionIdleTimer);
    _rivenSessionIdleTimer = null;
  }
  _callbacks = {
    onRivenSessionOpen: null,
    onRivenSessionClose: null,
    onRivenChatView: null,
    onRivenRollPending: null,
    onRivenRollConfirmed: null,
    onRivenDioramaSetup: null,
    onRivenChoiceConfirmed: null,
  };
}
