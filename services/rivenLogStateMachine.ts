import { withScope } from "./logger";

const log = withScope("rivenStateMachine");


export const RIVEN_PATTERNS = {
  sessionOpen: /Sys \[Info\]: Created \/Lotus\/Interface\/OmegaRerollSelection\.swf/,
  sessionClose: /NpcManager::ClearAgents\(\) ReadyToCreateAgents = false/,
  /** Matches any HudVis line - we extract the number to track increments/decrements. */
  hudVis: /ThemedDetailedPurchaseDialog\.lua: DBG: HudVis (\d+)/,
  /** Two-step riven detection: PopulateInfo with a Randomized mod path confirms it's a riven. */
  populateRiven: /ThemedDetailedPurchaseDialog\.lua: PopulateInfo->\/Lotus\/StoreItems\/Upgrades\/Mods\/Randomized\//,
  cycleConfirmEn:
    /Dialog::CreateOkCancel\(description=Are you sure you want to cycle (.+?) for ([\d,. ]+)\?/,
  choiceConfirmEn: /Dialog::CreateOkCancel\(description=Cycle Riven into current selection\?/,
  genericDialog: /Dialog::CreateOkCancel\(/,
  genericDialogNonInteractive: /leftItem=nil/,
  sendResult: /Dialog\.lua:\s*Dialog::SendResult\((\d+)\)/,
  dioramaSetup: /OmegaRerollSelection\.lua.*Diorama setup/i,
  /** The roll-screen diorama loads the riven's weapon model right after the
   *  screen opens - the resource path names the exact weapon variant. */
  dioramaWeaponLoad:
    /(?:ResourceLoader|Resloader|Resource load completed) 0x[0-9A-Fa-f]+ \((\/Lotus\/Weapons\/[^)]+)\)/,
  /** Extra close signal emitted by the recycled effects line. */
  recycledEffects: /ytes of recycled effects/,
} as const;


interface RivenCallbacks {
  onRivenSessionOpen: (() => void) | null;
  onRivenSessionClose: (() => void) | null;
  onRivenChatView: (() => void) | null;
  onRivenRollPending: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed: (() => void) | null;
  onRivenDioramaSetup: (() => void) | null;
  onRivenChoiceConfirmed: (() => void) | null;
  onRivenWeaponPath: ((weaponPath: string) => void) | null;
}

let _callbacks: RivenCallbacks = {
  onRivenSessionOpen: null,
  onRivenSessionClose: null,
  onRivenChatView: null,
  onRivenRollPending: null,
  onRivenRollConfirmed: null,
  onRivenDioramaSetup: null,
  onRivenChoiceConfirmed: null,
  onRivenWeaponPath: null,
};

export function setRivenCallbacks(cbs: Partial<RivenCallbacks>): void {
  _callbacks = { ..._callbacks, ...cbs };
}


let _rivenPendingDialog: "roll_confirm" | "choice" | null = null;
let _rivenSessionActive = false;
let _rivenSessionStartedAt = 0;
let _rivenSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
const RIVEN_SESSION_IDLE_TIMEOUT_MS = 120_000;
/**
 * Absolute ceiling on a single riven session. The 120s idle timer only fires
 * when matches stop arriving; if the user reliably pulls new rolls every <120s
 * (easy during bulk kuva grinding) the session can extend indefinitely. Nothing
 * downstream wants a "session" that's been open for an hour, so hard-cap at
 * 30 minutes and force-close even if matches keep coming.
 */
const RIVEN_SESSION_MAX_MS = 30 * 60_000;

let _rivenNextDialog: "cycle" | "choice" = "cycle";
let _rivenChatViewActive = false;

let _lastRivenSendResultAt = 0;
const RIVEN_SEND_RESULT_COOLDOWN_MS = 400;

let _lastRivenGenericDialogAt = 0;
const RIVEN_GENERIC_DIALOG_COOLDOWN_MS = 600;

let _lastRivenChoiceDialogAt = 0;
const RIVEN_CHOICE_DIALOG_COOLDOWN_MS = 2000;

let _lastRivenSessionOpenAt = 0;
// The game writes the rolling-screen marker dozens of times in one burst;
// log the suppression once per window instead of once per line.
let _lastSuppressedOpenLogAt = 0;
const RIVEN_SESSION_OPEN_COOLDOWN_MS = 15_000;

let _lastRivenDioramaAt = 0;
const RIVEN_DIORAMA_DEDUP_MS = 2_000;

/** True once this session's diorama weapon load was reported (once per session). */
let _rivenWeaponPathSent = false;

/** True once the diorama-setup line fires.
 * Close patterns (ClearAgents / recycled effects) are gated on this so that
 * lines emitted during the loading transition TO the riven screen are ignored. */
let _rivenDioramaReady = false;

let _rivenForceEndedAt = 0;
const RIVEN_FORCE_END_COOLDOWN_MS = 5_000;

/** Track HudVis for two-step chat riven detection. */
let _lastHudVis = 0;
let _lastHudVisIncreaseAt = 0;
const CHAT_RIVEN_POPULATE_WINDOW_MS = 2_000;


function resetRivenIdleTimer(): void {
  if (_rivenSessionIdleTimer) clearTimeout(_rivenSessionIdleTimer);
  _rivenSessionIdleTimer = setTimeout(() => {
    _rivenSessionIdleTimer = null;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    _rivenSessionActive = false;
    _rivenSessionStartedAt = 0;
    _rivenDioramaReady = false;
    _rivenWeaponPathSent = false;
    log.info("[EELog] Riven session idle timeout - resetting");
  }, RIVEN_SESSION_IDLE_TIMEOUT_MS);
}

/**
 * If the current session has exceeded RIVEN_SESSION_MAX_MS, force-close it and
 * fire the session-close callback. Call at the top of every log-line handler
 * that would otherwise extend the session, so a continuous stream of matches
 * can't keep a session alive past the cap.
 * Returns true if the session was force-closed on this call.
 */
function forceEndRivenSessionIfExpired(): boolean {
  if (!_rivenSessionActive || _rivenSessionStartedAt === 0) return false;
  if (Date.now() - _rivenSessionStartedAt < RIVEN_SESSION_MAX_MS) return false;

  log.info(`[EELog] Riven session exceeded ${RIVEN_SESSION_MAX_MS / 60_000}min cap - force closing`);
  _rivenSessionActive = false;
  _rivenSessionStartedAt = 0;
  _rivenDioramaReady = false;
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenWeaponPathSent = false;
  if (_rivenSessionIdleTimer) {
    clearTimeout(_rivenSessionIdleTimer);
    _rivenSessionIdleTimer = null;
  }
  _rivenForceEndedAt = Date.now();
  _callbacks.onRivenSessionClose?.();
  return true;
}


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

  // Hard cap: if the session's been open > RIVEN_SESSION_MAX_MS, force-close
  // before processing this line. Prevents a continuous kuva grind from keeping
  // a "session" alive indefinitely (the 120s idle timer only fires when
  // matches STOP).
  forceEndRivenSessionIfExpired();

  if (!skipRivenFromFilePoll && RIVEN_PATTERNS.sessionOpen.test(line)) {
    const now = Date.now();
    if (now - _lastRivenSessionOpenAt >= RIVEN_SESSION_OPEN_COOLDOWN_MS) {
      _lastRivenSessionOpenAt = now;
      _rivenSessionActive = true;
      _rivenSessionStartedAt = now;
      _rivenChatViewActive = false;
      _rivenNextDialog = "cycle";
      _rivenPendingDialog = null;
      _rivenWeaponPathSent = false;
      resetRivenIdleTimer();
      log.info("[EELog] Riven rolling screen opened -> dispatching session open");
      _callbacks.onRivenSessionOpen?.();
    } else if (now - _lastSuppressedOpenLogAt >= RIVEN_SESSION_OPEN_COOLDOWN_MS) {
      _lastSuppressedOpenLogAt = now;
      log.info("[EELog] Riven session open suppressed (cooldown)");
    }
  }

  // Diorama weapon load: between session open and diorama setup the screen
  // streams in the riven's weapon model - the resource path IS the weapon
  // (exact variant, localization-proof). Window is tight (~0.7s) so relay
  // bystander weapon loads cannot slip in later; once per session.
  if (_rivenSessionActive && !_rivenDioramaReady && !_rivenWeaponPathSent) {
    const weaponMatch = line.match(RIVEN_PATTERNS.dioramaWeaponLoad);
    if (weaponMatch) {
      _rivenWeaponPathSent = true;
      log.info(`[EELog] Riven diorama weapon load: ${weaponMatch[1]}`);
      _callbacks.onRivenWeaponPath?.(weaponMatch[1]);
    }
  }

  // Diorama ready: both cards are now displayed - trigger roll OCR immediately.
  // Arrives via both DBWIN and file poll. Not gated by skipRivenFromFilePoll
  // so it works regardless of which source delivers first.
  if (
    _rivenSessionActive &&
    RIVEN_PATTERNS.dioramaSetup.test(line)
  ) {
    const now = Date.now();
    if (now - _lastRivenDioramaAt >= RIVEN_DIORAMA_DEDUP_MS) {
      _lastRivenDioramaAt = now;
      _rivenDioramaReady = true;
      resetRivenIdleTimer();
      log.info("[EELog] Riven diorama ready -> dispatching diorama OCR trigger");
      _callbacks.onRivenDioramaSetup?.();
    }
  }

  // Session close: NpcManager::ClearAgents or recycled effects.
  // Gated on _rivenDioramaReady because these lines can fire during the loading
  // transition TO the riven screen, before the diorama is set up.
  if (!skipRivenFromFilePoll && _rivenSessionActive && _rivenDioramaReady && (RIVEN_PATTERNS.sessionClose.test(line) || RIVEN_PATTERNS.recycledEffects.test(line))) {
    log.info("[EELog] Riven session close detected -> dispatching overlay close");
    _rivenSessionActive = false;
    _rivenSessionStartedAt = 0;
    _rivenDioramaReady = false;
    _rivenPendingDialog = null;
    _rivenNextDialog = "cycle";
    _rivenWeaponPathSent = false;
    if (_rivenSessionIdleTimer) {
      clearTimeout(_rivenSessionIdleTimer);
      _rivenSessionIdleTimer = null;
    }
    _callbacks.onRivenSessionClose?.();
  }

  // Chat riven detection: a HudVis increment records a timestamp, and if a
  // PopulateInfo with a Randomized mod path shows up within 2s it's a riven.
  // A HudVis decrement means the chat item view closed.
  const hudVisMatch = line.match(RIVEN_PATTERNS.hudVis);
  if (hudVisMatch && !_rivenSessionActive) {
    const newVis = parseInt(hudVisMatch[1], 10);
    if (newVis < _lastHudVis) {
      // HudVis decreased -> chat item view closed
      if (_rivenChatViewActive) {
        _rivenChatViewActive = false;
        log.info("[EELog] Riven chat-link view closed (HudVis decreased) -> dispatching session close");
        _callbacks.onRivenSessionClose?.();
      }
    } else if (newVis > _lastHudVis) {
      // HudVis increased -> record timestamp, wait for PopulateInfo confirmation
      _lastHudVisIncreaseAt = Date.now();
    }
    _lastHudVis = newVis;
  }

  // PopulateInfo with Randomized mod path within 2s of HudVis increase = riven
  if (
    !_rivenSessionActive &&
    !_rivenChatViewActive &&
    RIVEN_PATTERNS.populateRiven.test(line) &&
    Date.now() - _lastHudVisIncreaseAt < CHAT_RIVEN_POPULATE_WINDOW_MS
  ) {
    _rivenChatViewActive = true;
    log.info("[EELog] Riven chat-link view confirmed (PopulateInfo within HudVis window) -> dispatching chat view");
    _callbacks.onRivenChatView?.();
  }

  let rivenDialogHandled = skipRivenFromFilePoll;

  const rivenCycleMatch = !skipRivenFromFilePoll ? line.match(RIVEN_PATTERNS.cycleConfirmEn) : null;
  if (rivenCycleMatch && !(!_rivenSessionActive && Date.now() - _rivenForceEndedAt < RIVEN_FORCE_END_COOLDOWN_MS)) {
    rivenDialogHandled = true;
    _rivenSessionActive = true;
    resetRivenIdleTimer();
    _rivenPendingDialog = "roll_confirm";
    const weapon = rivenCycleMatch[1].trim();
    const cost = parseInt(rivenCycleMatch[2].replace(/[,. ]/g, ""), 10) || 0;
    log.info(`[EELog] Riven roll pending: weapon=${weapon}, cost=${cost}`);
    _callbacks.onRivenRollPending?.(weapon, cost);
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
      log.info("[EELog] Riven choice dialog detected (English)");
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
      log.info("[EELog] Riven roll pending (generic dialog)");
      _callbacks.onRivenRollPending?.("", 0);
    } else {
      _rivenPendingDialog = "choice";
      log.info("[EELog] Riven choice dialog detected (generic)");
    }
  }

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
            log.info("[EELog] Riven roll confirmed -> dispatching OCR trigger");
            _callbacks.onRivenRollConfirmed?.();
          } else if (_rivenPendingDialog === "choice") {
            _rivenNextDialog = "cycle";
            log.info("[EELog] Riven choice confirmed -> dispatching choice scan");
            _callbacks.onRivenChoiceConfirmed?.();
          }
        }
      } else {
        log.info(`[EELog] Riven dialog cancelled (SendResult ${resultCode})`);
      }
      _rivenPendingDialog = null;
    }
  }

  return sendResultConsumedByRiven;
}


export function isRivenSessionActive(): boolean {
  return _rivenSessionActive;
}

export function forceEndRivenSession(): void {
  if (!_rivenSessionActive && !_rivenPendingDialog && !_rivenChatViewActive) return;
  _rivenSessionActive = false;
  _rivenSessionStartedAt = 0;
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
  log.info("[EELog] Riven session force-ended (overlay dismissed externally)");
}

export function resetRivenState(): void {
  _rivenPendingDialog = null;
  _rivenNextDialog = "cycle";
  _rivenSessionActive = false;
  _rivenSessionStartedAt = 0;
  _rivenDioramaReady = false;
  _rivenWeaponPathSent = false;
  _rivenChatViewActive = false;
  _lastRivenSendResultAt = 0;
  _lastRivenGenericDialogAt = 0;
  _lastRivenChoiceDialogAt = 0;
  _lastRivenSessionOpenAt = 0;
  _lastSuppressedOpenLogAt = 0;
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
    onRivenWeaponPath: null,
  };
}
