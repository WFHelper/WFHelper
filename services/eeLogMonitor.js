"use strict";

const log = require("./logger").withScope("eeLogMonitor");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");
const fs = require("node:fs");
const path = require("node:path");
const chokidar = require("chokidar");

const EE_LOG_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log")
  : null;

const REWARD_TRIGGER_PATTERNS = Object.freeze([/\bPause countdown done\b/i, /\bGot rewards\b/i]);
const RELIC_PICKER_PATTERNS = Object.freeze([
  /\bThemedProjectionManager\.lua:\s*PopulateInventoryGrid\b/i,
]);

const TRIGGER_DELAY_MS = 450;
const REWARD_TRIGGER_COOLDOWN_MS = 2500;
const RELIC_PICKER_COOLDOWN_MS = 2000;

let watcher = null;
let lastSize = 0;
let lineRemainder = "";

let rewardCallback = null;
let relicPickerCallback = null;

let pendingRewardTimer = null;
let pendingRelicPickerTimer = null;
let lastRewardAt = 0;
let lastRelicPickerAt = 0;

function clearPendingTimers() {
  if (pendingRewardTimer) {
    clearTimeout(pendingRewardTimer);
    pendingRewardTimer = null;
  }
  if (pendingRelicPickerTimer) {
    clearTimeout(pendingRelicPickerTimer);
    pendingRelicPickerTimer = null;
  }
}

function scheduleTrigger(type) {
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
  }, TRIGGER_DELAY_MS);
}

function handleLine(line) {
  if (!line) return;

  if (REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("reward");
  }

  if (RELIC_PICKER_PATTERNS.some((pattern) => pattern.test(line))) {
    scheduleTrigger("relic_picker");
  }
}

function consumeChunk(chunk) {
  const merged = lineRemainder + String(chunk || "");
  const lines = merged.split(/\r?\n/);
  lineRemainder = lines.pop() || "";

  for (const line of lines) {
    handleLine(line);
  }
}

function normalizeHandlers(handlers) {
  if (typeof handlers === "function") {
    return {
      onRewardTrigger: handlers,
      onRelicSelectionOpen: null,
    };
  }

  if (!handlers || typeof handlers !== "object") {
    return {
      onRewardTrigger: null,
      onRelicSelectionOpen: null,
    };
  }

  return {
    onRewardTrigger:
      typeof handlers.onRewardTrigger === "function" ? handlers.onRewardTrigger : null,
    onRelicSelectionOpen:
      typeof handlers.onRelicSelectionOpen === "function" ? handlers.onRelicSelectionOpen : null,
  };
}

function startWatching(handlers) {
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

  watcher.on("change", () => {
    try {
      const newSize = fs.statSync(EE_LOG_PATH).size;
      if (newSize <= lastSize) {
        lastSize = newSize;
        lineRemainder = "";
        return;
      }

      const chunkLen = newSize - lastSize;
      const buffer = Buffer.alloc(chunkLen);
      const fd = fs.openSync(EE_LOG_PATH, "r");
      fs.readSync(fd, buffer, 0, chunkLen, lastSize);
      fs.closeSync(fd);
      lastSize = newSize;

      consumeChunk(buffer.toString("utf8"));
    } catch (error) {
      log.error("[EELog] read error:", normalizeErrorMessage(error));
    }
  });

  log.log("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

function stopWatching() {
  clearPendingTimers();

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  rewardCallback = null;
  relicPickerCallback = null;
  lineRemainder = "";
}

module.exports = {
  startWatching,
  stopWatching,
  EE_LOG_PATH,
};
