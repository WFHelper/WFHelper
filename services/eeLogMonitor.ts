import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { withScope } from "./logger";
import { startDbwinWorker, stopDbwinWorker, isDbwinActive } from "./dbwinMonitor";
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
import type { ArbiRunRecord } from "../config/shared/arbiTypes";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { TradeType, TradeDirection } from "../config/shared/statsTypes";

const log = withScope("eeLogMonitor");

const EE_LOG_PATH: string | null = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log")
  : null;

const REWARD_TRIGGER_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bPause countdown done\b/i,
  /\bGot rewards\b/i,
]);
// Fires while the reward choice cards render (one line per un-cached icon).
// Lets the scan start early instead of waiting the full fixed delay.
const REWARD_UI_READY_PATTERN = /ProjectionRewardChoice\.lua:\s*Missing icon data!/i;
// Primary: LoadingCompleteEnd fires when the relic-selection screen is fully rendered
// and interactive.
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
// InitMapping marks returning to gameplay from the relic-selection screen (back, cancel,
// or relic chosen) because the game re-initialises input bindings after full-screen UI.
// RELIC_PICKER_CLOSE_MIN_GAP_MS guards against the InitMapping that fires when navigating
// TO the relic screen.
const RELIC_PICKER_CLOSE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bInitMapping for all devices with bindings\b/i,
]);
// TradingPost.lua emits a line like:
//   Script [Info]: TradingPost.lua: Initiating Trade With: <username>.
// We capture the username at the end, stripping a trailing period if present.
const TRADE_PARTNER_PATTERN = /TradingPost\.lua.*?[Tt]rade.*?[Ww]ith[: ]+([A-Za-z0-9_\-.]+)\.?\s*$/i;

// An incoming whisper opens a private chat tab, logged as:
//   ChatRedux::AddTab: Adding tab with channel name: F<User> to index <N>
// The message text is never logged - only that a conversation opened and from
// whom. The "F" prefix marks a private/whisper tab; strip it for the username.
const CHAT_TAB_MARKER = "ChatRedux::AddTab: Adding tab with channel name: ";

export function parseWhisperUsername(line: string): string | null {
  const start = line.indexOf(CHAT_TAB_MARKER);
  if (start < 0) return null;
  let name = line.slice(start + CHAT_TAB_MARKER.length);
  const end = name.indexOf(" to index");
  if (end < 0) return null;
  name = name.slice(0, end);
  if (!name.startsWith("F")) return null; // only private/whisper tabs
  // Warframe may append a non-ASCII platform glyph; drop it like AlecaFrame does.
  if (name.length > 1 && name.charCodeAt(name.length - 1) > 127) name = name.slice(0, -1);
  return name.slice(1).trim() || null;
}

/** Debounce before firing the reward-screen overlay after a log pattern match. */
const TRIGGER_DELAY_MS = 250;
// Warframe flushes EE.log lazily - the file poll re-delivers lines DBWIN
// already handled up to ~15s later (observed 15.4s), far past the trigger
// cooldown. While DBWIN is live, file reward lines only rescue rewards DBWIN
// missed entirely (no recent dispatch), instead of re-scanning at vote end.
const REWARD_FILE_ECHO_WINDOW_MS = 30_000;
/** Debounce for relic-picker - gives the in-game UI time to finish rendering. */
const RELIC_TRIGGER_DELAY_MS = 300;
/** Cooldown between consecutive reward scans to avoid duplicate log-line triggers. */
const REWARD_TRIGGER_COOLDOWN_MS = 2500;
// Covers delayed EE.log flushes after the DBWIN trigger has already fired.
const RELIC_PICKER_COOLDOWN_MS = 3000;
/** Grace period after close before another close can fire - debounces rapid log flushes. */
const RELIC_PICKER_CLOSE_COOLDOWN_MS = 500;
// Minimum gap between the last picker PATTERN line and a close being honoured.
// The inbound InitMapping (navigating TO the relic screen) lands around
// LoadingCompleteEnd, so measuring from the last pattern line keeps this guard
// tight; the old 3.5s-from-dispatch ate fast user closes and stranded the
// overlay until the safety net.
const RELIC_PICKER_CLOSE_MIN_GAP_MS = 1500;
// The mid-mission relic picker pauses the game and renders reward-preview
// cards, emitting "Pause countdown done" + ProjectionRewardChoice lines - a
// reward scan there reads the relic's possible-drops panel as a real reward.
const REWARD_AFTER_PICKER_SUPPRESS_MS = 3000;
// File polling is a backup path when DBWIN is inactive.
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
let rewardUiReadyCallback: (() => void) | null = null;
let relicPickerCallback: (() => void) | null = null;
let relicPickerCloseCallback: (() => void) | null = null;
let tradePartnerCallback: ((username: string) => void) | null = null;
let tradeConfirmedCallback: ((trade: ParsedLogTrade) => void) | null = null;
let messageCallback: ((playerName: string) => void) | null = null;
let activeMissionTagCallback: ((tag: string) => void) | null = null;

export { RIVEN_PATTERNS, forceEndRivenSession };

// Mission-info dumps print the fissure tier when a mission loads:
//   activeMissionTag=VoidT6           (key=value block)
//   "activeMissionTag" : "VoidT6",    (JSON block)
// VoidT1-5 map to relic eras; VoidT6 is an omnia fissure (any era).
const ACTIVE_MISSION_TAG_PATTERN = /(?:^|["\s])activeMissionTag["\s]*[=:]\s*"?([A-Za-z0-9_]+)/;

export function parseActiveMissionTag(line: string): string | null {
  if (!line.includes("activeMissionTag")) return null;
  const match = ACTIVE_MISSION_TAG_PATTERN.exec(line);
  return match ? match[1] : null;
}


interface ParsedLogTradeItem {
  displayName: string;
  count: number;
  direction: TradeDirection;
}

interface ParsedLogTrade {
  partner: string;
  platChange: number;
  type: TradeType;
  items: ParsedLogTradeItem[];
}

let _tradeDialogBuffer: string[] | null = null;
const TRADE_DIALOG_START = "Are you sure you want to accept this trade?";
const TRADE_SUCCESS = "The trade was successful!";
/** Max time to wait for the confirmation dialog to resolve before discarding buffered lines. */
const TRADE_DIALOG_TIMEOUT_MS = 60_000;
let _tradeDialogStartAt = 0;

let pendingRewardTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRelicPickerTimer: ReturnType<typeof setTimeout> | null = null;
let lastRewardAt = 0;
let lastRelicPickerAt = 0;
let lastRelicPickerPatternAt = 0;
let lastRelicPickerCloseAt = 0;
let relicPickerSessionOpen = false;

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
          notifyEeLogReset();
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

  // Stamped on every pattern line (even inside the cooldown) - the reward
  // suppression and the close guard both key on the freshest picker activity.
  if (!isReward) lastRelicPickerPatternAt = now;

  if (now - lastAt < cooldown) return;

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
      lastRewardAt = Date.now();
      if (rewardCallback) {
        log.info("[EELog] Reward trigger detected -> dispatching reward scan");
        rewardCallback();
      }
    }, TRIGGER_DELAY_MS);
    return;
  }

  if (pendingRelicPickerTimer) return;
  pendingRelicPickerTimer = setTimeout(() => {
    pendingRelicPickerTimer = null;
    lastRelicPickerAt = Date.now();
    relicPickerSessionOpen = true;
    if (relicPickerCallback) {
      log.info("[EELog] Relic picker trigger detected -> dispatching recommendation overlay");
      relicPickerCallback();
    }
  }, RELIC_TRIGGER_DELAY_MS);
}

function handleLine(line: string, source: "dbwin" | "file" = "file"): void {
  if (!line) return;

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    const isFlushEcho =
      source === "file" &&
      isDbwinActive() &&
      Date.now() - lastRewardAt < REWARD_FILE_ECHO_WINDOW_MS;
    if (isFlushEcho) {
      log.info("[EELog] Reward file echo ignored - DBWIN already handled this crack");
    } else {
      scheduleTrigger("reward");
    }
  }

  if (rewardUiReadyCallback && REWARD_UI_READY_PATTERN.test(line)) {
    rewardUiReadyCallback();
  }

  // When DBWIN is active, skip relic picker pattern processing from file-poll lines.
  // DBWIN delivers lines instantly; the file poll re-delivers the same lines later,
  // causing phantom re-opens after cooldown expiry.
  const skipRelicFromFilePoll = isDbwinActive() && source === "file";

  if (!skipRelicFromFilePoll && RELIC_PICKER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("relic_picker");
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
    if (whisperUser) {
      log.info("[EELog] In-game conversation from:", whisperUser);
      messageCallback(whisperUser);
    }
  }

  if (activeMissionTagCallback) {
    const missionTag = parseActiveMissionTag(line);
    if (missionTag) {
      log.info("[EELog] activeMissionTag:", missionTag);
      activeMissionTagCallback(missionTag);
    }
  }

  // Start buffering on the dialog description line.
  // Stop buffering when a new log-framework prefix appears ([Info]/[Error]/[Warning]).
  // Single-line dialogs (ending with leftItem=/Menu/Confirm_Item_Ok) are handled immediately.
  if (line.includes(TRADE_DIALOG_START)) {
    _tradeDialogBuffer = [line];
    _tradeDialogStartAt = Date.now();
    // Single-line dialogs (..., leftItem=/Menu/Confirm_Item_Ok) are already complete
    // at this point - the buffered line stands; we just wait for the success line.
  } else if (_tradeDialogBuffer !== null) {
    // Stop buffering when a log framework line appears.
    if (/\[(Info|Error|Warning)\]/.test(line)) {
      // Buffer is complete - don't add this line, just stop buffering and wait for success
    } else if (Date.now() - _tradeDialogStartAt > TRADE_DIALOG_TIMEOUT_MS) {
      _tradeDialogBuffer = null;
    } else {
      _tradeDialogBuffer.push(line);
    }
  }

  if (line.includes(TRADE_SUCCESS) && _tradeDialogBuffer !== null) {
    const parsed = _parseTradeDialog(_tradeDialogBuffer);
    _tradeDialogBuffer = null;
    if (parsed && tradeConfirmedCallback) {
      log.info(`[EELog] Trade confirmed: ${parsed.type} ${parsed.platChange}p with ${parsed.partner}, ${parsed.items.length} item(s)`);
      tradeConfirmedCallback(parsed);
    }
  }

  // Delegate to the riven state machine - returns whether SendResult was consumed.
  processRivenPatterns(line, source, isDbwinActive());

  // Arbitration run tracking (internally ignores dbwin-source lines).
  processArbiLine(line, source);

  // InitMapping fires when the game returns to gameplay from any full-screen UI.
  // Guard against riven session (SendResult during riven belongs to the riven flow)
  // and against file-poll duplicates when DBWIN is active.
  if (!isRivenSessionActive() && !skipRelicFromFilePoll && RELIC_PICKER_CLOSE_PATTERNS.some((pattern) => pattern.test(line))) {
    const now = Date.now();
    if (relicPickerSessionOpen && now - lastRelicPickerCloseAt >= RELIC_PICKER_CLOSE_COOLDOWN_MS) {
      lastRelicPickerCloseAt = now;
      if (now - Math.max(lastRelicPickerAt, lastRelicPickerPatternAt) < RELIC_PICKER_CLOSE_MIN_GAP_MS) {
        // Too close to the last picker activity - this InitMapping is from
        // navigating TO the relic screen, not FROM it. Skip to avoid closing
        // the overlay immediately after it opens.
        log.info("[EELog] Relic picker close skipped - too close to last open trigger");
      } else if (relicPickerCloseCallback) {
        relicPickerSessionOpen = false;
        log.info("[EELog] Relic picker close detected -> dispatching overlay close");
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
export function _parseTradeDialog(lines: string[]): ParsedLogTrade | null {
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
      // Skip EE.log framework lines that may have leaked into the buffer
      if (/\[(Info|Error|Warning)\]/.test(line)) continue;
      // Skip lines that look like log timestamps or system messages
      if (/^\d+\.\d+\s/.test(line)) continue;
      // Remove trailing comma from last item "..., leftItem=..."
      const cleaned = line.replace(/,\s*leftItem=.*$/i, "").replace(/\r/g, "").trim();
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
  onRewardUiReady?: (() => void) | null;
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
}

type NormalizedEeLogHandlers = {
  [K in keyof EeLogHandlers]-?: NonNullable<EeLogHandlers[K]> | null;
};

const NULL_EE_LOG_HANDLERS: NormalizedEeLogHandlers = {
  onRewardTrigger: null,
  onRewardUiReady: null,
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
    onRewardTrigger: asFunction(handlers.onRewardTrigger),
    onRewardUiReady: asFunction(handlers.onRewardUiReady),
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
  rewardUiReadyCallback = normalized.onRewardUiReady;
  relicPickerCallback = normalized.onRelicSelectionOpen;
  relicPickerCloseCallback = normalized.onRelicSelectionClose;
  relicPickerSessionOpen = false;
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
    notifyEeLogReset();
  });

  pollTimer = setInterval(pollReadNewBytes, POLL_INTERVAL_MS);
  if (typeof (pollTimer as NodeJS.Timeout)?.unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
  pollReadNewBytes();

  startDbwinWorker((line) => handleLine(line, "dbwin"));

  log.info("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

export function stopWatching(): void {
  shutdownArbiTracker();
  stopDbwinWorker();
  clearPendingTimers();
  clearPollTimer();
  closePollFd();

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  rewardCallback = null;
  rewardUiReadyCallback = null;
  relicPickerCallback = null;
  relicPickerCloseCallback = null;
  resetRivenState();
  lineRemainder = "";
  relicPickerSessionOpen = false;
}
