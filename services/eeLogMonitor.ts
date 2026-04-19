import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { withScope } from "./logger";
import { startDbwinWorker, stopDbwinWorker, isDbwinActive } from "./dbwinMonitor";
import {
  RIVEN_PATTERNS as _RIVEN_PATTERNS,
  processRivenPatterns,
  setRivenCallbacks,
  forceEndRivenSession as _forceEndRivenSession,
  isRivenSessionActive,
  resetRivenState,
} from "./rivenLogStateMachine";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { TradeType, TradeDirection } from "../config/shared/statsTypes";

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
// AlecaFrame uses "InitMapping for all devices with bindings" to detect when the player
// leaves the relic-selection screen (back, cancel, or relic chosen). This line fires when
// the game re-initialises input bindings on returning to gameplay from any full-screen UI.
// RELIC_PICKER_CLOSE_MIN_GAP_MS guards against the InitMapping that fires when navigating
// TO the relic screen (same guard as AlecaFrame: "Skipped relic close because it was too
// close to the recommendation start!").
const RELIC_PICKER_CLOSE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bInitMapping for all devices with bindings\b/i,
]);
// TradingPost.lua emits a line like:
//   Script [Info]: TradingPost.lua: Initiating Trade With: <username>.
// We capture the username at the end, stripping a trailing period if present.
const TRADE_PARTNER_PATTERN = /TradingPost\.lua.*?[Tt]rade.*?[Ww]ith[: ]+([A-Za-z0-9_\-.]+)\.?\s*$/i;

/** Debounce before firing the reward-screen overlay after a log pattern match. */
const TRIGGER_DELAY_MS = 450;
/** Debounce for relic-picker — gives the in-game UI time to finish rendering. */
const RELIC_TRIGGER_DELAY_MS = 300;
/**
 * Cooldown between consecutive reward scans to avoid re-triggering on
 * duplicate log lines.
 *
 * 2500 ms is tuned to exceed the typical gap between DBWIN and file-poll
 * re-delivery of the same event (usually < 1 s observed, < 2 s worst case)
 * while staying well below the minimum time between two legitimate
 * reward screens (successive mission completions are always separated by
 * loading + navigation flow, > 10 s in practice). Lower values re-fire
 * the overlay; higher values risk dropping a legitimate rapid-retry.
 */
const REWARD_TRIGGER_COOLDOWN_MS = 2500;
// DBWIN fires at T=0 (instant); EE.log file flush can lag 0–5 s behind.
// With both sources active the file-based read would re-trigger the overlay
// seconds later unless the cooldown covers the full flush window.
// 8 s is safely larger than any observed EE.log flush delay, yet far smaller
// than the minimum realistic time between two consecutive fissure mission entries.
// 3 s is enough to absorb any DBWIN→file-poll re-deliver after DBWIN becomes inactive.
// skipRelicFromFilePoll handles the common case while DBWIN is active.
const RELIC_PICKER_COOLDOWN_MS = 3000;
/** Grace period after close before another close can fire — debounces rapid log flushes. */
const RELIC_PICKER_CLOSE_COOLDOWN_MS = 500;
// Minimum gap between the last open trigger and a close trigger being honoured.
// Prevents InitMapping from closing the overlay when it fires as part of
// the navigation flow that leads TO the relic selection screen.
// AlecaFrame uses 3.5 s when a relic was just opened, 500 ms otherwise;
// we use 3.5 s as a safe unified guard.
const RELIC_PICKER_CLOSE_MIN_GAP_MS = 3500;
// File-based poll is a safety net — DBWIN delivers lines with zero-latency.
// 500 ms keeps the backup responsive while cutting CPU wake-ups by 5×.
const POLL_INTERVAL_MS = 500;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LOOPS_PER_TICK = 8;
/** How often we check whether EE.log was truncated/rotated (game restart detection). */
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

// Re-export from extracted modules for backward compatibility
export const RIVEN_PATTERNS = _RIVEN_PATTERNS;
export const forceEndRivenSession = _forceEndRivenSession;

// ── Trade dialog multi-line buffer ────────────────────────────────────────────

export interface ParsedLogTradeItem {
  displayName: string;
  count: number;
  direction: TradeDirection;
}

export interface ParsedLogTrade {
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
let lastRelicPickerCloseAt = 0;

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

function handleLine(line: string, source: "dbwin" | "file" = "file"): void {
  if (!line) return;

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("reward");
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
    if (username && typeof tradePartnerCallback === "function") {
      log.log("[EELog] Trade partner detected:", username);
      tradePartnerCallback(username);
    }
  }

  // ── Trade dialog buffering ─────────────────────────────────────────────────
  // AlecaFrame behavior: start buffering on the dialog description line.
  // Stop buffering when a new log-framework prefix appears ([Info]/[Error]/[Warning]).
  // Single-line dialogs (ending with leftItem=/Menu/Confirm_Item_Ok) are handled immediately.
  if (line.includes(TRADE_DIALOG_START)) {
    _tradeDialogBuffer = [line];
    _tradeDialogStartAt = Date.now();
    // Check if single-line dialog (all content on one line)
    if (line.includes(", leftItem=/Menu/Confirm_Item_Ok")) {
      // Single-line: buffer is complete, wait for trade success confirmation
    }
  } else if (_tradeDialogBuffer !== null) {
    // Stop buffering when a log framework line appears (matches AlecaFrame behavior)
    if (/\[(Info|Error|Warning)\]/.test(line)) {
      // Buffer is complete — don't add this line, just stop buffering and wait for success
    } else if (Date.now() - _tradeDialogStartAt > TRADE_DIALOG_TIMEOUT_MS) {
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
  // Delegate to the riven state machine — returns whether SendResult was consumed.
  processRivenPatterns(line, source, isDbwinActive());

  // ── Relic picker close detection ────────────────────────────────────────────
  // InitMapping fires when the game returns to gameplay from any full-screen UI.
  // Guard against riven session (SendResult during riven belongs to the riven flow)
  // and against file-poll duplicates when DBWIN is active.
  if (!isRivenSessionActive() && !skipRelicFromFilePoll && RELIC_PICKER_CLOSE_PATTERNS.some((pattern) => pattern.test(line))) {
    const now = Date.now();
    if (now - lastRelicPickerCloseAt >= RELIC_PICKER_CLOSE_COOLDOWN_MS) {
      lastRelicPickerCloseAt = now;
      if (now - lastRelicPickerAt < RELIC_PICKER_CLOSE_MIN_GAP_MS) {
        // Too close to the last open trigger — this InitMapping is from navigating
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
      // Skip EE.log framework lines that may have leaked into the buffer
      if (/\[(Info|Error|Warning)\]/.test(line)) continue;
      // Skip lines that look like log timestamps or system messages
      if (/^\d+\.\d+\s/.test(line)) continue;
      // Remove trailing comma from last item "..., leftItem=..."
      const cleaned = line.replace(/,\s*leftItem=.*$/i, "").replace(/\r/g, "").trim();
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
  const isSale = platGained > 0 && platSpent === 0;
  const isPurchase = platSpent > 0 && platGained === 0;
  const type = isSale ? "sale" : isPurchase ? "purchase" : "trade";
  const platChange = Math.max(platGained, platSpent);

  // Set directions
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
  onRelicSelectionOpen?: (() => void) | null;
  onRelicSelectionClose?: (() => void) | null;
  onTradingPartner?: ((username: string) => void) | null;
  onTradeConfirmed?: ((trade: ParsedLogTrade) => void) | null;
  onRivenSessionOpen?: (() => void) | null;
  onRivenSessionClose?: (() => void) | null;
  onRivenRollPending?: ((weapon: string, kuvaPerRoll: number) => void) | null;
  onRivenRollConfirmed?: (() => void) | null;
  onRivenDioramaSetup?: (() => void) | null;
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
  onRivenDioramaSetup: (() => void) | null;
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
      onRivenDioramaSetup: null,
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
      onRivenDioramaSetup: null,
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
    onRivenDioramaSetup:
      typeof handlers.onRivenDioramaSetup === "function" ? handlers.onRivenDioramaSetup : null,
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
  setRivenCallbacks({
    onRivenSessionOpen: normalized.onRivenSessionOpen,
    onRivenSessionClose: normalized.onRivenSessionClose,
    onRivenRollPending: normalized.onRivenRollPending,
    onRivenRollConfirmed: normalized.onRivenRollConfirmed,
    onRivenDioramaSetup: normalized.onRivenDioramaSetup,
    onRivenChoiceConfirmed: normalized.onRivenChoiceConfirmed,
    onRivenChatView: normalized.onRivenChatView,
  });

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
  if (typeof (pollTimer as NodeJS.Timeout)?.unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
  pollReadNewBytes();

  startDbwinWorker((line) => handleLine(line, "dbwin"));

  log.log("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

/**
 * Force-ends the riven rolling session.  Call when the overlay is dismissed by
 * ESC or any external trigger that does NOT produce a NpcManager::ClearAgents()
 * EE.log pattern.  Without this, `_rivenSessionActive` stays true and subsequent
 * EE.log events (e.g. a choice dialog line arriving after the user dismissed the
 * overlay) re-trigger scans against already-closed windows.
 *
 * Safe to call when no session is active — returns early in that case.
 */
// forceEndRivenSession is re-exported from rivenLogStateMachine at the top of this file.

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
  resetRivenState();
  lineRemainder = "";
}