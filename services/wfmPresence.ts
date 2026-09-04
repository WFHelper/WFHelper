import { normalizeErrorMessage } from "../config/shared/errors";
import {
  WFM_AWAY_IDLE_MINUTES_DEFAULT,
  normalizeWfmAwayIdleMinutes,
  normalizeWfmHoldMinutes,
  wfmStatusCanExpire,
  type WfmStatus,
} from "../config/shared/wfm";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import * as wfmSession from "./wfmSession";

const log = withScope("wfmPresence");

export interface WfmPresenceState {
  status: WfmStatus | null;
  /** Epoch ms the current status drops to invisible; null while it is held indefinitely. */
  expiresAt: number | null;
  /** True while the status is driven by Warframe running rather than by the user. */
  autoActive: boolean;
  /** True while an away rule (idle PC, or Warframe closed) is holding invisible. */
  awayActive: boolean;
}

/** Which rule currently owns the account status; null means the user does. */
type PresenceOverride = "auto" | "away" | null;

let _status: WfmStatus | null = null;
let _expiresAt: number | null = null;
let _holdTimer: ReturnType<typeof setTimeout> | null = null;
let _autoEnabled = false;
let _holdMinutes = 0;
let _gameOpen = false;
let _override: PresenceOverride = null;
// Status to put back when the override ends; null when we never captured one.
let _preOverrideStatus: WfmStatus | null = null;
let _awayIdleEnabled = false;
let _awayIdleMinutes = WFM_AWAY_IDLE_MINUTES_DEFAULT;
let _awayClosedEnabled = false;
let _idleSeconds = 0;
let _idleAway = false;
// A manual pick disarms the away rules; the next idle or game edge re-arms them.
let _awayArmed = true;
let _onChange: ((state: WfmPresenceState) => void) | null = null;

// Neither override push expires, so both survive an app quit. The record
// survives with them, letting the next run reclaim and restore a status it owns.
const PRESENCE_OVERRIDE_FILE = "wfm-presence.json";
const STARTUP_RECLAIM_DELAY_MS = 5_000;

interface PersistedOverride {
  override: PresenceOverride;
  restore: WfmStatus | null;
}

function presenceOverridePath(): string | null {
  try {
    return userDataPath(PRESENCE_OVERRIDE_FILE);
  } catch {
    return null;
  }
}

function readOverride(): PersistedOverride {
  const file = presenceOverridePath();
  const empty: PersistedOverride = { override: null, restore: null };
  if (!file) return empty;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const restore = raw.restore;
    return {
      override: raw.autoActive === true ? "auto" : raw.awayActive === true ? "away" : null,
      restore:
        restore === "online" || restore === "ingame" || restore === "invisible" ? restore : null,
    };
  } catch {
    return empty;
  }
}

/** Writes the override this run owns, so the next one can put the status back. */
function writeOverride(): void {
  const file = presenceOverridePath();
  if (!file) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const payload = {
      autoActive: _override === "auto",
      awayActive: _override === "away",
      restore: _preOverrideStatus,
    };
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch (err) {
    log.warn("[WFMPresence] presence override write failed:", normalizeErrorMessage(err));
  }
}

export function getState(): WfmPresenceState {
  return {
    status: _status,
    expiresAt: _expiresAt,
    autoActive: _override === "auto",
    awayActive: _override === "away",
  };
}

function _emit(): void {
  try {
    _onChange?.(getState());
  } catch (err) {
    log.warn("[WFMPresence] onChange callback threw:", normalizeErrorMessage(err));
  }
}

function _clearHold(): void {
  if (_holdTimer) clearTimeout(_holdTimer);
  _holdTimer = null;
  _expiresAt = null;
}

/** WFM expires the status itself; this only mirrors the deadline locally so the
 * countdown and the buttons settle without waiting for the next server push. */
function _trackDeadline(statusUntil: string | null): void {
  if (_holdTimer) clearTimeout(_holdTimer);
  _holdTimer = null;
  const deadline = statusUntil ? Date.parse(statusUntil) : NaN;
  if (!Number.isFinite(deadline)) {
    _expiresAt = null;
    return;
  }

  _expiresAt = deadline;
  _holdTimer = setTimeout(
    () => {
      _holdTimer = null;
      _expiresAt = null;
      _status = "invisible";
      log.info("[WFMPresence] Hold elapsed - WFM dropped the status");
      _emit();
    },
    Math.max(0, deadline - Date.now()),
  );
  const timerRef = _holdTimer as { unref?: () => void };
  if (typeof timerRef.unref === "function") timerRef.unref();
}

/** Seconds of hold to ask WFM for. Auto-driven presence is bounded by the game
 * running instead, so it goes up without an expiry. */
function _durationFor(status: WfmStatus, auto: boolean): number | null {
  if (auto || !_holdMinutes || !wfmStatusCanExpire(status)) return null;
  return _holdMinutes * 60;
}

/** Send a status to WFM and record it as the one we want the account to hold. */
async function _push(status: WfmStatus, auto = false): Promise<boolean> {
  if (!wfmSession.getToken()) return false;
  try {
    const result = await wfmSession.setStatus(status, _durationFor(status, auto));
    _status = status;
    _trackDeadline(result.statusUntil);
    _emit();
    return true;
  } catch (err) {
    log.warn(`[WFMPresence] Failed to set status ${status}:`, normalizeErrorMessage(err));
    return false;
  }
}

/** Recompute the idle flag; an edge either way re-arms the away rules. */
function _refreshIdleAway(): boolean {
  const away = _awayIdleEnabled && _idleSeconds >= _awayIdleMinutes * 60;
  if (away === _idleAway) return false;
  _idleAway = away;
  _awayArmed = true;
  return true;
}

/** Auto In Game outranks the away rules on purpose: being AFK inside the game
 * is the game's business, and the account already advertises "In Game" there. */
function _wantedOverride(): PresenceOverride {
  if (_gameOpen && _autoEnabled) return "auto";
  if (!_awayArmed) return null;
  if (_awayClosedEnabled && !_gameOpen) return "away";
  return _awayIdleEnabled && _idleAway ? "away" : null;
}

/** Re-run the auto/away rules against the current game, idle and option state.
 * `_override` moves before the push so a concurrent poll cannot double-send. */
async function _applyOverride(): Promise<void> {
  if (!wfmSession.getToken()) return;
  const wanted = _wantedOverride();
  if (wanted === _override) return;
  const previous = _override;

  if (wanted === "auto") {
    // Entering from rest captures what to put back; an "ingame" there is a stale
    // echo of a previous run's push, not a restore target.
    if (!previous) _preOverrideStatus = _status === "ingame" ? null : _status;
    _override = "auto";
    log.info("[WFMPresence] Warframe running - setting status to ingame");
    if (await _push("ingame", true)) writeOverride();
    else _override = previous;
    return;
  }

  if (wanted === "away") {
    // Already hidden by hand: nothing to replace and nothing to put back.
    if (!previous && _status === "invisible") return;
    if (!previous) _preOverrideStatus = _status;
    _override = "away";
    log.info("[WFMPresence] Away - setting status to invisible");
    if (!(await _push("invisible"))) _override = previous;
    else writeOverride();
    return;
  }

  // Unknown prior status stays hidden rather than guessing someone visible.
  const restore = _preOverrideStatus ?? "invisible";
  _override = null;
  log.info(`[WFMPresence] ${previous} status ended - restoring status to ${restore}`);
  // A failed restore keeps the override and schedules its own retry: the game
  // and idle polls only call in on an edge, so nothing else would try again.
  if (!(await _push(restore))) {
    _override = previous;
    _scheduleRestoreRetry();
    return;
  }
  _clearRestoreRetry();
  _preOverrideStatus = null;
  writeOverride();
}

const RESTORE_RETRY_MS = 60_000;
let _restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;

function _clearRestoreRetry(): void {
  if (_restoreRetryTimer) clearTimeout(_restoreRetryTimer);
  _restoreRetryTimer = null;
}

function _scheduleRestoreRetry(): void {
  _clearRestoreRetry();
  _restoreRetryTimer = setTimeout(() => {
    _restoreRetryTimer = null;
    void _applyOverride();
  }, RESTORE_RETRY_MS);
  const timerRef = _restoreRetryTimer as { unref?: () => void };
  if (typeof timerRef.unref === "function") timerRef.unref();
}

export function configure(handlers: { onChange?: (state: WfmPresenceState) => void }): void {
  _onChange = handlers.onChange ?? null;
}

/** Push the persisted settings in; called on boot and on every settings save. */
export function setOptions(options: {
  autoIngameEnabled: boolean;
  holdMinutes: unknown;
  awayIdleEnabled?: boolean;
  awayIdleMinutes?: unknown;
  awayWhenClosedEnabled?: boolean;
}): void {
  const holdMinutes = normalizeWfmHoldMinutes(options.holdMinutes);
  const awayIdleEnabled = options.awayIdleEnabled === true;
  const awayIdleMinutes = normalizeWfmAwayIdleMinutes(options.awayIdleMinutes);
  const awayClosedEnabled = options.awayWhenClosedEnabled === true;
  const holdChanged = holdMinutes !== _holdMinutes;
  const autoChanged = options.autoIngameEnabled !== _autoEnabled;
  const awayChanged =
    awayIdleEnabled !== _awayIdleEnabled ||
    awayIdleMinutes !== _awayIdleMinutes ||
    awayClosedEnabled !== _awayClosedEnabled;
  _holdMinutes = holdMinutes;
  _autoEnabled = options.autoIngameEnabled;
  _awayIdleEnabled = awayIdleEnabled;
  _awayIdleMinutes = awayIdleMinutes;
  _awayClosedEnabled = awayClosedEnabled;

  // A new duration only takes effect by re-sending the status, same as the site.
  if (holdChanged && _status && wfmStatusCanExpire(_status) && !_override) {
    void _push(_status);
  }
  // Toggling mid-session must catch an already-running game or an idle PC, and
  // turning a rule off must not strand the account on the status it pushed.
  if (awayChanged) {
    _awayArmed = true;
    _refreshIdleAway();
  }
  if (autoChanged || awayChanged) void _applyOverride();
  if (holdChanged || autoChanged || awayChanged) _emit();
}

/** Re-evaluate the rules against the last known state (e.g. after sign-in). */
export function resync(): void {
  void _applyOverride();
}

/** Seed the current status from WFM so the UI reflects reality after a restart.
 * The deadline arrives separately, on the socket's status push. */
export async function refreshFromServer(): Promise<void> {
  const status = await wfmSession.getPublicStatus();
  if (!status || _status) return;
  _status = status;
  _emit();
  // A previous run's own push - reclaim it so this run can restore it. The
  // delay lets the first game poll land before deciding the game is closed.
  const saved = readOverride();
  const reclaimed =
    status === "ingame" && saved.override === "auto"
      ? "auto"
      : status === "invisible" && saved.override === "away"
        ? "away"
        : null;
  if (reclaimed) {
    _override = reclaimed;
    // An "ingame" restore target is a stale echo of the auto push itself.
    _preOverrideStatus = reclaimed === "auto" ? null : saved.restore;
    log.info(`[WFMPresence] Reclaimed an ${reclaimed} status from a previous run`);
    const timer = setTimeout(() => void _applyOverride(), STARTUP_RECLAIM_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}

/** WFM announced our status - on sign-in, or after a change made elsewhere.
 * This is the authoritative source for the expiry WFM is counting down. */
export function applyServerStatus(payload: unknown): void {
  const record = (payload ?? {}) as { status?: unknown; statusUntil?: unknown };
  const status = String(record.status ?? "").toLowerCase();
  if (status !== "online" && status !== "ingame" && status !== "invisible") return;

  // A status the site changed during a hold is the newest thing the user asked
  // for, so it becomes what the override puts back instead of the entry value.
  if (_override && status !== (_override === "auto" ? "ingame" : "invisible")) {
    _preOverrideStatus = status;
    writeOverride();
  }
  _status = status;
  _trackDeadline(typeof record.statusUntil === "string" ? record.statusUntil : null);
  _emit();
}

/** User picked a status: it wins over the auto and away rules, which only re-arm
 * on the next game-state or idle edge. */
export async function setManualStatus(status: WfmStatus): Promise<void> {
  const hadOverride = _override !== null;
  _override = null;
  _preOverrideStatus = null;
  _awayArmed = false;
  if (hadOverride) writeOverride();
  const applied = await _push(status);
  if (!applied) throw new Error("Not logged in to Warframe.market.");
}

/** Warframe started or stopped. Edge-triggered by the main-process status poll. */
export async function syncGameRunning(isOpen: boolean): Promise<void> {
  // A game-state edge re-arms away rules that a manual pick disarmed.
  if (isOpen !== _gameOpen) _awayArmed = true;
  _gameOpen = isOpen;
  await _applyOverride();
}

/** Seconds since the last keyboard or mouse input, sampled by main every 30s. */
export function syncIdle(idleSeconds: unknown): void {
  const seconds = Number(idleSeconds);
  _idleSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (_refreshIdleAway()) void _applyOverride();
}

/** Main only samples system idle time while the idle rule can act on it. */
export function needsIdlePolling(): boolean {
  return _awayIdleEnabled;
}

export function reset(): void {
  _clearHold();
  _clearRestoreRetry();
  _status = null;
  _override = null;
  _preOverrideStatus = null;
  _idleSeconds = 0;
  _idleAway = false;
  _awayArmed = true;
  _emit();
}
