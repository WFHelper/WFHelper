import { withScope } from "./logger";

const log = withScope("rivenStateMachine");

// ── Riven log patterns ────────────────────────────────────────────────────────

export const RIVEN_PATTERNS = {
  sessionOpen: /Sys \[Info\]: Created \/Lotus\/Interface\/OmegaRerollSelection\.swf/,
  sessionClose: /NpcManager::ClearAgents\(\) ReadyToCreateAgents = false/,
  /** Matches any HudVis line — we extract the number to track increments/decrements. */
  hudVis: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis (\d+)/,
  /** Two-step riven detection: PopulateInfo with a Randomized mod path confirms it's a riven. */
  populateRiven: /ThemedDetailedPurchaseDialog\.lua: PopulateInfo->\/Lotus\/StoreItems\/Upgrades\/Mods\/Randomized\//,
  cycleConfirmEn:
    /Dialog::CreateOkCancel\(description=Are you sure you want to cycle (.+?) for ([\d,. ]+)\?/,
  choiceConfirmEn: /Dialog::CreateOkCancel\(description=Cycle Riven into current selection\?/,
  genericDialog: /Dialog::CreateOkCancel\(/,
  genericDialogNonInteractive: /leftItem=nil/,
  sendResult: /Dialog\.lua:\s*Dialog::SendResult\((\d+)\)/,
  diaoramaSetup: /OmegaRerollSelection\.lua.*Diorama setup/i,
  /** Extra close signal used by AlecaFrame: recycled effects line. */
  recycledEffects: /ytes of recycled effects/,
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

/** True once the diorama-setup line fires — mirrors AlecaFrame's `isRerollUIOpen`.
 * Close patterns (ClearAgents / recycled effects) are gated on this so that
 * lines emitted during the loading transition TO the riven screen are ignored. */
let _rivenDioramaReady = false;

let _rivenForceEndedAt = 0;
const RIVEN_FORCE_END_COOLDOWN_MS = 5_000;

/** Track HudVis for two-step chat riven detection (AlecaFrame-style). */
let _lastHudVis = 0;
let _lastHudVisIncreaseAt = 0;
const CHAT_RIVEN_POPULATE_WINDOW_MS = 2_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetRivenIdleTimer(): void {
  if (_rivenSessionIdleTimer) clearTimeout(_rivenSessionIdleTimer);
  _rivenSessionIdleTimer = setTimeout(() => {
    _rivenSessionIdleTimer = null;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    _rivenSessionActive = false;
    _rivenDioramaReady = false;
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
  // Arrives via both DBWIN and file poll. Not gated by skipRivenFromFilePoll
  // so it works regardless of which source delivers first.
  if (
    _rivenSessionActive &&
    RIVEN_PATTERNS.diaoramaSetup.test(line)
  ) {
    const now = Date.now();
    if (now - _lastRivenDioramaAt >= RIVEN_DIORAMA_DEDUP_MS) {
      _lastRivenDioramaAt = now;
      _rivenDioramaReady = true;
      resetRivenIdleTimer();
      log.log("[EELog] Riven diorama ready -> dispatching diorama OCR trigger");
      if (typeof _callbacks.onRivenDioramaSetup === "function") _callbacks.onRivenDioramaSetup();
    }
  }

  // Session close: NpcManager::ClearAgents or recycled effects.
  // Gated on _rivenDioramaReady (mirrors AlecaFrame's isRerollUIOpen) — these lines
  // fire during the loading transition TO the riven screen, before the diorama is set up.
  if (!skipRivenFromFilePoll && _rivenSessionActive && _rivenDioramaReady && (RIVEN_PATTERNS.sessionClose.test(line) || RIVEN_PATTERNS.recycledEffects.test(line))) {
    log.log("[EELog] Riven session close detected -> dispatching overlay close");
    _rivenSessionActive = false;
    _rivenDioramaReady = false;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    if (_rivenSessionIdleTimer) {
      clearTimeout(_rivenSessionIdleTimer);
      _rivenSessionIdleTimer = null;
    }
    if (typeof _callbacks.onRivenSessionClose === "function") _callbacks.onRivenSessionClose();
  }

  // ── Riven chat-link view (two-step AlecaFrame-style detection) ──────────
  // Step 1: Track HudVis changes. On increment, record timestamp.
  // Step 2: If PopulateInfo with Randomized mod path appears within 2s, it's a riven.
  // On decrement, close the chat riven view.
  const hudVisMatch = line.match(RIVEN_PATTERNS.hudVis);
  if (hudVisMatch && !_rivenSessionActive) {
    const newVis = parseInt(hudVisMatch[1], 10);
    if (newVis < _lastHudVis) {
      // HudVis decreased → chat item view closed
      if (_rivenChatViewActive) {
        _rivenChatViewActive = false;
        log.log("[EELog] Riven chat-link view closed (HudVis decreased) -> dispatching session close");
        if (typeof _callbacks.onRivenSessionClose === "function") _callbacks.onRivenSessionClose();
      }
    } else if (newVis > _lastHudVis) {
      // HudVis increased → record timestamp, wait for PopulateInfo confirmation
      _lastHudVisIncreaseAt = Date.now();
    }
    _lastHudVis = newVis;
  }

  // Step 2: PopulateInfo with Randomized mod path within 2s of HudVis increase = riven
  if (
    !_rivenSessionActive &&
    !_rivenChatViewActive &&
    RIVEN_PATTERNS.populateRiven.test(line) &&
    Date.now() - _lastHudVisIncreaseAt < CHAT_RIVEN_POPULATE_WINDOW_MS
  ) {
    _rivenChatViewActive = true;
    log.log("[EELog] Riven chat-link view confirmed (PopulateInfo within HudVis window) -> dispatching chat view");
    if (typeof _callbacks.onRivenChatView === "function") _callbacks.onRivenChatView();
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
  if (!_rivenSessionActive && !_rivenPendingDialog && !_rivenChatViewActive) return;
  _rivenSessionActive = false;
  _rivenDioramaReady = false;
  _rivenChatViewActive = false;
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenForceEndedAt = Date.now();
  _lastHudVis = 0;
  _lastHudVisIncreaseAt = 0;
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
  _rivenDioramaReady = false;
  _rivenChatViewActive = false;
  _lastRivenSendResultAt = 0;
  _lastRivenGenericDialogAt = 0;
  _lastRivenChoiceDialogAt = 0;
  _lastRivenSessionOpenAt = 0;
  _lastHudVis = 0;
  _lastHudVisIncreaseAt = 0;
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
