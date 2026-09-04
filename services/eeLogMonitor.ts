import fs from "node:fs";
import chokidar from "chokidar";
import { withScope } from "./logger";
import { EeUptimeTracker } from "./eeUptime";
import { startDbwinWorker, stopDbwinWorker, isDbwinActive } from "./dbwinMonitor";

export { dbwinWorkerStopped } from "./dbwinMonitor";
import {
  startProtonDebugstrMonitor,
  stopProtonDebugstrMonitor,
  isProtonDebugstrActive,
} from "./protonDebugstrMonitor";
import { resolveEeLogPath } from "./eeLogPath";
import {
  RIVEN_PATTERNS,
  processRivenPatterns,
  setRivenCallbacks,
  forceEndRivenSession,
  isRivenSessionActive,
  resetRivenState,
} from "./rivenLogStateMachine";
import {
  processArbiLine,
  notifyEeLogReset,
  shutdownArbiTracker,
  setArbiCallbacks,
} from "./arbiRunTracker";
import {
  processProfitTakerLine,
  notifyPtEeLogReset,
  shutdownPtTracker,
  setPtCallbacks,
} from "./profitTakerTracker";
import type { ArbiRunRecord } from "../config/shared/arbiTypes";
import type { PtRunRecord } from "../config/shared/profitTakerTypes";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { TradeType, TradeDirection } from "../config/shared/statsTypes";
import { stripPlatformGlyphs, isLogFrameworkLine, stripDialogArgTail } from "./tradeLogSanitize";

const log = withScope("eeLogMonitor");
const LOGIN_COMPLETE_PATTERN = /\bMainMenu::LoginDone result=true\b/;
const LOGIN_COMPLETE_DEDUP_MS = 30_000;

// Both real-time sources share the "dbwin" line tag, so file-poll echo dedup
// behaves identically whether lines arrive via DBWIN or the Proton log tail.
function realtimeSourceActive(): boolean {
  return isDbwinActive() || isProtonDebugstrActive();
}

/** Resolved by startWatching() via eeLogPath discovery; null until then. */
let EE_LOG_PATH: string | null = null;

const REWARD_TRIGGER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bPause countdown done\b/i,
  /\bGot rewards\b/i,
]);
// Fires while the reward choice cards render (one line per un-cached icon).
// Lets the scan start early instead of waiting the full fixed delay.
const REWARD_UI_READY_PATTERN = /ProjectionRewardChoice\.lua:\s*Missing icon data!/i;
// Fires the moment the in-game reward screen closes - after "Selection
// countdown done" (vote ended) or "Reward choice force closed" (solo confirm).
const REWARD_SCREEN_CLOSE_PATTERN = /ProjectionRewardChoice\.lua:\s*Relic reward screen shut down/i;
// Keep the earlier PopulateInventoryGrid fallback in case DE renames LoadingCompleteEnd.
const RELIC_PICKER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bThemedProjectionManager\.lua:\s*LoadingCompleteEnd\b/i,
  /\bProjection[A-Za-z_]*\.lua:\s*LoadingCompleteEnd\b/i,
  /\bThemedProjectionManager\.lua:\s*PopulateInventoryGrid\b/i,
  /\bProjectionManager\.lua:\s*PopulateInventoryGrid\b/i,
  /\bProjection[A-Za-z_]*\.lua:\s*PopulateInventoryGrid\b/i,
]);
// InitMapping fires entering and leaving full-screen UI, so the gap distinguishes exit.
const RELIC_PICKER_CLOSE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bInitMapping for all devices with bindings\b/i,
]);
// TradingPost.lua appends punctuation after the counterparty; exclude it from the name.
const TRADE_PARTNER_PATTERN =
  /TradingPost\.lua.*?[Tt]rade.*?[Ww]ith[: ]+([A-Za-z0-9_\-.]+)\.?\s*$/i;

// Private chat tabs prefix the username with F; message text is not logged.
const CHAT_TAB_MARKER = "ChatRedux::AddTab: Adding tab with channel name: ";

export function parseWhisperUsername(line: string): string | null {
  const start = line.indexOf(CHAT_TAB_MARKER);
  if (start < 0) return null;
  let name = line.slice(start + CHAT_TAB_MARKER.length);
  const end = name.indexOf(" to index");
  if (end < 0) return null;
  name = name.slice(0, end);
  if (!name.startsWith("F")) return null; // only private/whisper tabs
  // Warframe appends a platform glyph (U+E000). DBWIN delivers it latin1 as
  // 3 chars, the file poll utf8 as 1 - strip all so both sources agree.
  name = name.replace(/[\u0080-\uffff]+$/, "");
  return name.slice(1).trim() || null;
}

// The file poll re-delivers dbwin-handled lines up to ~26s later (lazy flush)
// - dedupe per sender; a line dbwin missed is first-seen here and still fires.
const WHISPER_DEDUP_MS = 30_000;
const _lastWhisperSeen = new Map<string, number>();

function isWhisperEcho(playerName: string, now: number): boolean {
  const previous = _lastWhisperSeen.get(playerName);
  _lastWhisperSeen.set(playerName, now);
  if (_lastWhisperSeen.size > 64) {
    for (const [name, ts] of _lastWhisperSeen) {
      if (now - ts >= WHISPER_DEDUP_MS) _lastWhisperSeen.delete(name);
    }
  }
  return previous !== undefined && now - previous < WHISPER_DEDUP_MS;
}

/** Debounce before firing the reward-screen overlay after a log pattern match. */
const TRIGGER_DELAY_MS = 250;
// Lazy file flushes trail DBWIN beyond the cooldown; only rescue missed dispatches.
const REWARD_FILE_ECHO_WINDOW_MS = 30_000;
/** Debounce for relic-picker - gives the in-game UI time to finish rendering. */
const RELIC_TRIGGER_DELAY_MS = 300;
/** Cooldown between consecutive reward scans to avoid duplicate log-line triggers. */
const REWARD_TRIGGER_COOLDOWN_MS = 2500;
// Covers delayed EE.log flushes after the DBWIN trigger has already fired.
const RELIC_PICKER_COOLDOWN_MS = 3000;
/** Grace period after close before another close can fire - debounces rapid log flushes. */
const RELIC_PICKER_CLOSE_COOLDOWN_MS = 500;
// Entry InitMapping trails the open dispatch only briefly.
const RELIC_PICKER_ENTRY_WINDOW_MS = 800;

/** InitMapping also fires on picker entry; skip it once per session, near open. */
export function isPickerEntryMapping(
  now: number,
  lastOpenAt: number,
  entrySkipUsed: boolean,
): boolean {
  return !entrySkipUsed && now - lastOpenAt < RELIC_PICKER_ENTRY_WINDOW_MS;
}
// Suppress reward scans while the relic picker renders reward-preview cards.
const REWARD_AFTER_PICKER_SUPPRESS_MS = 3000;
// File polling is a backup path when DBWIN is inactive.
const POLL_INTERVAL_MS = 500;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LOOPS_PER_TICK = 8;
const TRUNCATION_CHECK_INTERVAL_MS = 2000;
// The engine buffers file writes; at mission end a reward line can hit the
// file 10-15s late. Past the vote window the reward screen is gone - drop.
const REWARD_STALE_SUPPRESS_MS = 20_000;

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let lastSize = 0;
let lineRemainder = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollFd: number | null = null;
let pollReading = false;
let lastTruncationCheckAt = 0;
const pollBuffer = Buffer.alloc(MAX_READ_BYTES);
const uptimeTracker = new EeUptimeTracker();

let rewardCallback: ((stalenessMs: number) => void) | null = null;
let rewardUiReadyCallback: (() => void) | null = null;
let eeConfigSavedCallback: (() => void) | null = null;
let rewardScreenCloseCallback: ((stalenessMs: number) => void) | null = null;
let relicPickerCallback: (() => void) | null = null;
let relicPickerCloseCallback: (() => void) | null = null;
let tradePartnerCallback: ((username: string) => void) | null = null;
let tradeConfirmedCallback: ((trade: ParsedLogTrade) => void) | null = null;
let messageCallback: ((playerName: string) => void) | null = null;
let activeMissionTagCallback: ((tag: string) => void) | null = null;
let loginCompleteCallback: (() => void) | null = null;
let lastLoginCompleteAt = 0;

export { RIVEN_PATTERNS, forceEndRivenSession };

/** The game writes settings (interface scale included) to EE.cfg lazily; this
 *  line is the only signal that the file just changed. */
export function isEeConfigSavedLine(line: string): boolean {
  return /Saved package: \/Configs\/EE\.cfg\s*$/.test(line);
}

export function isLoginCompleteLine(line: string): boolean {
  return LOGIN_COMPLETE_PATTERN.test(line);
}

// Mission-info dumps use both key-value and JSON shapes; VoidT6 means omnia.
const ACTIVE_MISSION_TAG_PATTERN = /(?:^|["\s])activeMissionTag["\s]*[=:]\s*"?([A-Za-z0-9_]+)/;

export function parseActiveMissionTag(line: string): string | null {
  if (!line.includes("activeMissionTag")) return null;
  const match = ACTIVE_MISSION_TAG_PATTERN.exec(line);
  return match ? match[1] : null;
}

// Extraction or abort ends the fissure; no orbiter line re-tags afterwards,
// so the tier tag must not survive into the orbiter's relic picker.
const MISSION_END_PATTERN = /Sys \[Info\]: EOM missionLocationUnlocked=|TopMenu\.lua: Abort:/;

export function isMissionEndLine(line: string): boolean {
  return MISSION_END_PATTERN.test(line);
}

interface ParsedLogTradeItem {
  displayName: string;
  count: number;
  direction: TradeDirection;
}

export interface ParsedLogTrade {
  partner: string;
  platChange: number;
  type: TradeType;
  items: ParsedLogTradeItem[];
  /** Game uptime stamp of the dialog line - identifies this exact trade. */
  logStamp: string | null;
}

let _tradeDialogBuffer: string[] | null = null;
const TRADE_DIALOG_START = "Are you sure you want to accept this trade?";
const TRADE_SUCCESS = "The trade was successful!";
/** Max time to wait for the confirmation dialog to resolve before discarding buffered lines. */
const TRADE_DIALOG_TIMEOUT_MS = 60_000;
let _tradeDialogStartAt = 0;
/** Set once the dialog's log entry ends - later log lines must not leak into the buffer. */
let _tradeDialogSealed = false;

let pendingRewardTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRelicPickerTimer: ReturnType<typeof setTimeout> | null = null;
let lastRewardAt = 0;
let lastRelicPickerAt = 0;
let lastRelicPickerPatternAt = 0;
let lastRelicPickerCloseAt = 0;
let relicPickerSessionOpen = false;
let relicPickerEntrySkipUsed = false;

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
          lastLoginCompleteAt = 0;
          uptimeTracker.reset();
          notifyEeLogReset();
          notifyPtEeLogReset();
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

/** Consume EE.log bytes already on disk now instead of waiting for the next 500ms
 * tick. Only moves the needle on a backlog past one tick's 2 MiB read cap; the
 * engine's lazy flush is what delays fresh lines, and no poll shortens that. */
export function forceEeLogPoll(): void {
  pollReadNewBytes();
}

function scheduleTrigger(
  type: "reward" | "relic_picker",
  source: "dbwin" | "file",
  stalenessMs = 0,
): void {
  const isReward = type === "reward";
  const now = Date.now();
  const lastAt = isReward ? lastRewardAt : lastRelicPickerAt;
  const cooldown = isReward ? REWARD_TRIGGER_COOLDOWN_MS : RELIC_PICKER_COOLDOWN_MS;

  // Stamped on every pattern line (even inside the cooldown) - the reward
  // suppression and the close guard both key on the freshest picker activity.
  if (!isReward) lastRelicPickerPatternAt = now;

  if (now - lastAt < cooldown) return;

  const staleNote = stalenessMs > 1000 ? `, ~${(stalenessMs / 1000).toFixed(1)}s stale` : "";

  if (isReward) {
    if (pendingRewardTimer) return;
    pendingRewardTimer = setTimeout(() => {
      pendingRewardTimer = null;
      if (Date.now() - lastRelicPickerPatternAt < REWARD_AFTER_PICKER_SUPPRESS_MS) {
        // deliberately leaves lastRewardAt untouched so a real reward right
        // after the window isn't cooldown-blocked
        log.info("[EELog] Reward trigger suppressed - relic picker screen active");
        return;
      }
      if (stalenessMs > REWARD_STALE_SUPPRESS_MS) {
        log.warn(
          `[EELog] Reward trigger dropped - line is ~${(stalenessMs / 1000).toFixed(1)}s old (engine flush lag), reward screen is gone`,
        );
        return;
      }
      lastRewardAt = Date.now();
      if (rewardCallback) {
        log.info(
          `[EELog] Reward trigger detected (via ${source}${staleNote}) -> dispatching reward scan`,
        );
        if (source === "file" && isDbwinActive() && stalenessMs > 3000) {
          log.warn(
            "[EELog] DBWIN is active but missed this line - another debug listener may be competing (DebugView/Overwolf)",
          );
        }
        rewardCallback(stalenessMs);
      }
    }, TRIGGER_DELAY_MS);
    return;
  }

  if (pendingRelicPickerTimer) return;
  pendingRelicPickerTimer = setTimeout(() => {
    pendingRelicPickerTimer = null;
    lastRelicPickerAt = Date.now();
    relicPickerSessionOpen = true;
    relicPickerEntrySkipUsed = false;
    if (relicPickerCallback) {
      log.info(
        `[EELog] Relic picker trigger detected (via ${source}${staleNote}) -> dispatching recommendation overlay`,
      );
      relicPickerCallback();
    }
  }, RELIC_TRIGGER_DELAY_MS);
}

function handleLine(line: string, source: "dbwin" | "file" = "file"): void {
  if (!line) return;

  // DBWIN lines are real-time; file lines can trail the event by the engine's
  // lazy flush (10s+ at quiet moments) - measure it from the uptime prefix.
  const stalenessMs = source === "file" ? uptimeTracker.observe(line, Date.now()) : 0;

  if (loginCompleteCallback && isLoginCompleteLine(line)) {
    const now = Date.now();
    if (now - lastLoginCompleteAt >= LOGIN_COMPLETE_DEDUP_MS) {
      lastLoginCompleteAt = now;
      loginCompleteCallback();
    }
  }

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    const isFlushEcho =
      source === "file" &&
      realtimeSourceActive() &&
      Date.now() - lastRewardAt < REWARD_FILE_ECHO_WINDOW_MS;
    if (isFlushEcho) {
      log.info("[EELog] Reward file echo ignored - DBWIN already handled this crack");
    } else {
      scheduleTrigger("reward", source, stalenessMs);
    }
  }

  if (rewardUiReadyCallback && REWARD_UI_READY_PATTERN.test(line)) {
    rewardUiReadyCallback();
  }

  // The consumer re-reads EE.cfg and pushes the current value, so the DBWIN
  // line plus its file-poll echo firing twice is harmless.
  if (eeConfigSavedCallback && isEeConfigSavedLine(line)) {
    eeConfigSavedCallback();
  }

  if (rewardScreenCloseCallback && REWARD_SCREEN_CLOSE_PATTERN.test(line)) {
    rewardScreenCloseCallback(stalenessMs);
  }

  // Skip delayed file echoes while DBWIN is active to prevent phantom reopens.
  const skipRelicFromFilePoll = realtimeSourceActive() && source === "file";

  if (!skipRelicFromFilePoll && RELIC_PICKER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("relic_picker", source, stalenessMs);
  }

  const tradeMatch = TRADE_PARTNER_PATTERN.exec(line);
  if (tradeMatch && tradeMatch[1]) {
    const username = tradeMatch[1].replace(/\.$/, "").trim();
    if (username && tradePartnerCallback) {
      log.info("[EELog] Trade partner detected:", username);
      tradePartnerCallback(username);
    }
  }

  if (messageCallback) {
    const whisperUser = parseWhisperUsername(line);
    if (whisperUser && !isWhisperEcho(whisperUser, Date.now())) {
      log.info("[EELog] In-game conversation from:", whisperUser);
      messageCallback(whisperUser);
    }
  }

  if (activeMissionTagCallback) {
    const missionTag = parseActiveMissionTag(line);
    if (missionTag) {
      log.info("[EELog] activeMissionTag:", missionTag);
      activeMissionTagCallback(missionTag);
    } else if (isMissionEndLine(line)) {
      activeMissionTagCallback("EndOfMission");
    }
  }

  // A new framework prefix seals multiline dialogs; single-line dialogs seal immediately.
  if (line.includes(TRADE_DIALOG_START)) {
    _tradeDialogBuffer = [line];
    _tradeDialogStartAt = Date.now();
    _tradeDialogSealed = false;
    // Single-line dialogs (..., leftItem=/Menu/Confirm_Item_Ok) are already complete
    // at this point - the buffered line stands; we just wait for the success line.
  } else if (_tradeDialogBuffer !== null) {
    if (Date.now() - _tradeDialogStartAt > TRADE_DIALOG_TIMEOUT_MS) {
      _tradeDialogBuffer = null;
    } else if (/\[(Info|Error|Warning)\]/.test(line)) {
      // Next log framework line marks the end of the dialog's multi-line entry.
      // Seal so intervening log entries can't leak in as trade items.
      _tradeDialogSealed = true;
    } else if (!_tradeDialogSealed) {
      _tradeDialogBuffer.push(line);
    }
  }

  if (line.includes(TRADE_SUCCESS) && _tradeDialogBuffer !== null) {
    const parsed = _parseTradeDialog(_tradeDialogBuffer);
    _tradeDialogBuffer = null;
    _tradeDialogSealed = false;
    if (parsed && tradeConfirmedCallback) {
      log.info(
        `[EELog] Trade confirmed: ${parsed.type} ${parsed.platChange}p with ${parsed.partner}, ${parsed.items.length} item(s)`,
      );
      tradeConfirmedCallback(parsed);
    }
  }

  // Delegate to the riven state machine - returns whether SendResult was consumed.
  processRivenPatterns(line, source, realtimeSourceActive());

  // Arbitration and Profit-Taker run tracking (both ignore dbwin-source lines).
  processArbiLine(line, source);
  processProfitTakerLine(line, source);

  // Riven flow and delayed file echoes make InitMapping unsafe as a picker close.
  if (
    !isRivenSessionActive() &&
    !skipRelicFromFilePoll &&
    RELIC_PICKER_CLOSE_PATTERNS.some((pattern) => pattern.test(line))
  ) {
    const now = Date.now();
    if (relicPickerSessionOpen && now - lastRelicPickerCloseAt >= RELIC_PICKER_CLOSE_COOLDOWN_MS) {
      if (isPickerEntryMapping(now, lastRelicPickerAt, relicPickerEntrySkipUsed)) {
        relicPickerEntrySkipUsed = true;
        log.info("[EELog] Relic picker close skipped - entry InitMapping");
      } else if (relicPickerCloseCallback) {
        lastRelicPickerCloseAt = now;
        relicPickerSessionOpen = false;
        log.info("[EELog] Relic picker close detected -> dispatching overlay close");
        relicPickerCloseCallback();
      }
    }
  }
}

/** Parse the buffered trade confirmation dialog. */
export function _parseTradeDialog(lines: string[]): ParsedLogTrade | null {
  const text = lines.join("\n");

  // Extract the description between the trigger text and the leftItem suffix
  const descStart = text.indexOf("You are offering:");
  if (descStart < 0) return null;
  const desc = text.slice(descStart);

  // Split on the "and will receive from <partner> the following:" divider
  const receiveMatch = desc.match(/and will receive from\s+(.+?)\s+the following:/i);
  if (!receiveMatch) return null;
  // The game may append a platform glyph to the username (same as whispers).
  const partner = stripPlatformGlyphs(receiveMatch[1]);

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
      if (/^(leftItem|rightItem|title)=/.test(line)) break;
      // Skip EE.log framework lines that may have leaked into the buffer
      if (isLogFrameworkLine(line)) continue;
      // Drop Dialog arg tails glued to the last item ("..., title= leftItem=...")
      // and platform glyphs embedded in names (glyph-only lines become empty).
      const cleaned = stripPlatformGlyphs(stripDialogArgTail(line).replace(/\r/g, ""));
      if (!cleaned) continue;

      const platMatch = cleaned.match(/^Platinum(?:\s+x\s+(\d+))?$/i);
      if (platMatch) {
        plat += platMatch[1] ? parseInt(platMatch[1], 10) : 1;
        continue;
      }
      // Stacked items log as "Name x N" (one slot); non-stacking items repeat
      // one line each. Handle both so partial-quantity closes are accurate.
      let name = cleaned;
      let qty = 1;
      const stackMatch = cleaned.match(/^(.+?)\s+x\s+(\d+)$/i);
      if (stackMatch) {
        name = stackMatch[1].trim();
        qty = parseInt(stackMatch[2], 10) || 1;
      }
      counts.set(name, (counts.get(name) || 0) + qty);
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
  const isSale = platGained > 0 && platSpent === 0;
  const isPurchase = platSpent > 0 && platGained === 0;
  const type = isSale ? "sale" : isPurchase ? "purchase" : "trade";
  const platChange = Math.max(platGained, platSpent);

  for (const item of offered.items) item.direction = "given";
  for (const item of received.items) item.direction = "received";

  return {
    partner,
    platChange,
    type,
    items: [...offered.items, ...received.items],
    logStamp: /^(\d+\.\d+)\b/.exec(lines[0] || "")?.[1] ?? null,
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
  onLoginComplete?: (() => void) | null;
  onRewardTrigger?: ((stalenessMs: number) => void) | null;
  onRewardUiReady?: (() => void) | null;
  onEeConfigSaved?: (() => void) | null;
  onRewardScreenClose?: ((stalenessMs: number) => void) | null;
  onRelicSelectionOpen?: (() => void) | null;
  onRelicSelectionClose?: (() => void) | null;
  onTradingPartner?: ((username: string) => void) | null;
  onTradeConfirmed?: ((trade: ParsedLogTrade) => void) | null;
  onInGameMessage?: ((playerName: string) => void) | null;
  onActiveMissionTag?: ((tag: string) => void) | null;
  onRivenSessionOpen?: (() => void) | null;
  onRivenSessionClose?: (() => void) | null;
  onRivenRollPending?: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed?: (() => void) | null;
  onRivenDioramaSetup?: (() => void) | null;
  onRivenChoiceConfirmed?: (() => void) | null;
  onRivenChatView?: (() => void) | null;
  onRivenWeaponPath?: ((weaponPath: string) => void) | null;
  onArbiRunSaved?: ((run: ArbiRunRecord) => void) | null;
  onPtRunSaved?: ((run: PtRunRecord) => void) | null;
}

type NormalizedEeLogHandlers = {
  [K in keyof EeLogHandlers]-?: NonNullable<EeLogHandlers[K]> | null;
};

const NULL_EE_LOG_HANDLERS: NormalizedEeLogHandlers = {
  onLoginComplete: null,
  onRewardTrigger: null,
  onRewardUiReady: null,
  onEeConfigSaved: null,
  onRewardScreenClose: null,
  onRelicSelectionOpen: null,
  onRelicSelectionClose: null,
  onTradingPartner: null,
  onTradeConfirmed: null,
  onInGameMessage: null,
  onActiveMissionTag: null,
  onRivenSessionOpen: null,
  onRivenSessionClose: null,
  onRivenRollPending: null,
  onRivenRollConfirmed: null,
  onRivenDioramaSetup: null,
  onRivenChoiceConfirmed: null,
  onRivenChatView: null,
  onRivenWeaponPath: null,
  onArbiRunSaved: null,
  onPtRunSaved: null,
};

/** Keep a value only when it is a function, else null. */
function asFunction<T>(value: T | null | undefined): T | null {
  return typeof value === "function" ? value : null;
}

function normalizeHandlers(
  handlers: (() => void) | EeLogHandlers | null | undefined,
): NormalizedEeLogHandlers {
  if (typeof handlers === "function") {
    return { ...NULL_EE_LOG_HANDLERS, onRewardTrigger: handlers };
  }

  if (!handlers || typeof handlers !== "object") {
    return { ...NULL_EE_LOG_HANDLERS };
  }

  return {
    onLoginComplete: asFunction(handlers.onLoginComplete),
    onRewardTrigger: asFunction(handlers.onRewardTrigger),
    onRewardUiReady: asFunction(handlers.onRewardUiReady),
    onEeConfigSaved: asFunction(handlers.onEeConfigSaved),
    onRewardScreenClose: asFunction(handlers.onRewardScreenClose),
    onRelicSelectionOpen: asFunction(handlers.onRelicSelectionOpen),
    onRelicSelectionClose: asFunction(handlers.onRelicSelectionClose),
    onTradingPartner: asFunction(handlers.onTradingPartner),
    onTradeConfirmed: asFunction(handlers.onTradeConfirmed),
    onInGameMessage: asFunction(handlers.onInGameMessage),
    onActiveMissionTag: asFunction(handlers.onActiveMissionTag),
    onRivenSessionOpen: asFunction(handlers.onRivenSessionOpen),
    onRivenSessionClose: asFunction(handlers.onRivenSessionClose),
    onRivenRollPending: asFunction(handlers.onRivenRollPending),
    onRivenRollConfirmed: asFunction(handlers.onRivenRollConfirmed),
    onRivenDioramaSetup: asFunction(handlers.onRivenDioramaSetup),
    onRivenChoiceConfirmed: asFunction(handlers.onRivenChoiceConfirmed),
    onRivenChatView: asFunction(handlers.onRivenChatView),
    onRivenWeaponPath: asFunction(handlers.onRivenWeaponPath),
    onArbiRunSaved: asFunction(handlers.onArbiRunSaved),
    onPtRunSaved: asFunction(handlers.onPtRunSaved),
  };
}

export function startWatching(
  handlers: (() => void) | EeLogHandlers | null | undefined,
): string | null {
  EE_LOG_PATH = resolveEeLogPath();
  if (!EE_LOG_PATH) {
    log.warn("[EELog] EE.log location not found; monitoring unavailable");
    return null;
  }
  if (!fs.existsSync(EE_LOG_PATH)) {
    log.warn("[EELog] EE.log not found at:", EE_LOG_PATH);
    return null;
  }

  const normalized = normalizeHandlers(handlers);
  loginCompleteCallback = normalized.onLoginComplete;
  lastLoginCompleteAt = 0;
  rewardCallback = normalized.onRewardTrigger;
  rewardUiReadyCallback = normalized.onRewardUiReady;
  eeConfigSavedCallback = normalized.onEeConfigSaved;
  rewardScreenCloseCallback = normalized.onRewardScreenClose;
  relicPickerCallback = normalized.onRelicSelectionOpen;
  relicPickerCloseCallback = normalized.onRelicSelectionClose;
  relicPickerSessionOpen = false;
  relicPickerEntrySkipUsed = false;
  tradePartnerCallback = normalized.onTradingPartner;
  tradeConfirmedCallback = normalized.onTradeConfirmed;
  messageCallback = normalized.onInGameMessage;
  activeMissionTagCallback = normalized.onActiveMissionTag;
  setRivenCallbacks({
    onRivenSessionOpen: normalized.onRivenSessionOpen,
    onRivenSessionClose: normalized.onRivenSessionClose,
    onRivenRollPending: normalized.onRivenRollPending,
    onRivenRollConfirmed: normalized.onRivenRollConfirmed,
    onRivenDioramaSetup: normalized.onRivenDioramaSetup,
    onRivenChoiceConfirmed: normalized.onRivenChoiceConfirmed,
    onRivenChatView: normalized.onRivenChatView,
    onRivenWeaponPath: normalized.onRivenWeaponPath,
  });
  setArbiCallbacks({ onRunSaved: normalized.onArbiRunSaved });
  setPtCallbacks({ onRunSaved: normalized.onPtRunSaved });

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
    lastLoginCompleteAt = 0;
    notifyEeLogReset();
    notifyPtEeLogReset();
  });

  pollTimer = setInterval(pollReadNewBytes, POLL_INTERVAL_MS);
  if (typeof (pollTimer as NodeJS.Timeout)?.unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
  pollReadNewBytes();

  // Proton can supply the same real-time stream; otherwise the file poll remains active.
  if (process.platform === "win32") {
    startDbwinWorker((line) => handleLine(line, "dbwin"));
  } else if (process.platform === "linux") {
    startProtonDebugstrMonitor((line) => handleLine(line, "dbwin"));
  }

  log.info("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

export function stopWatching(): void {
  shutdownArbiTracker();
  shutdownPtTracker();
  stopDbwinWorker();
  stopProtonDebugstrMonitor();
  clearPendingTimers();
  clearPollTimer();
  closePollFd();

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  rewardCallback = null;
  loginCompleteCallback = null;
  lastLoginCompleteAt = 0;
  rewardUiReadyCallback = null;
  eeConfigSavedCallback = null;
  rewardScreenCloseCallback = null;
  relicPickerCallback = null;
  relicPickerCloseCallback = null;
  resetRivenState();
  lineRemainder = "";
  relicPickerSessionOpen = false;
  relicPickerEntrySkipUsed = false;
}
