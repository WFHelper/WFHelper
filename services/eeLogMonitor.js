"use strict";

const log = require('./logger').withScope('eeLogMonitor');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const EE_LOG_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Warframe', 'EE.log')
  : null;

const REWARD_TRIGGER_PATTERNS = Object.freeze([
  /\bPause countdown done\b/i,
  /\bGot rewards\b/i,
]);

const TRIGGER_DELAY_MS = 500;
const TRIGGER_COOLDOWN_MS = 2500;

let watcher = null;
let lastSize = 0;
let rewardCallback = null;
let pendingTriggerTimer = null;
let lastTriggerAt = 0;

function clearPendingTrigger() {
  if (!pendingTriggerTimer) return;
  clearTimeout(pendingTriggerTimer);
  pendingTriggerTimer = null;
}

function scheduleRewardTrigger() {
  const now = Date.now();
  if ((now - lastTriggerAt) < TRIGGER_COOLDOWN_MS) {
    return;
  }
  if (pendingTriggerTimer) {
    return;
  }

  pendingTriggerTimer = setTimeout(() => {
    pendingTriggerTimer = null;
    lastTriggerAt = Date.now();

    if (typeof rewardCallback === 'function') {
      log.log('[EELog] Reward screen trigger detected -> dispatching overlay scan');
      rewardCallback();
    }
  }, TRIGGER_DELAY_MS);
}

function containsRewardTrigger(chunk) {
  return REWARD_TRIGGER_PATTERNS.some((pattern) => pattern.test(chunk));
}

function startWatching(onReward) {
  if (!EE_LOG_PATH) {
    log.warn('[EELog] LOCALAPPDATA not set; EE.log monitoring unavailable');
    return null;
  }
  if (!fs.existsSync(EE_LOG_PATH)) {
    log.warn('[EELog] EE.log not found at:', EE_LOG_PATH);
    return null;
  }

  rewardCallback = onReward;

  try {
    lastSize = fs.statSync(EE_LOG_PATH).size;
  } catch {
    lastSize = 0;
  }

  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(EE_LOG_PATH, {
    persistent: true,
    usePolling: false,
    awaitWriteFinish: false,
  });

  watcher.on('change', () => {
    try {
      const newSize = fs.statSync(EE_LOG_PATH).size;
      if (newSize <= lastSize) {
        lastSize = newSize;
        return;
      }

      const chunkLen = newSize - lastSize;
      const buffer = Buffer.alloc(chunkLen);
      const fd = fs.openSync(EE_LOG_PATH, 'r');
      fs.readSync(fd, buffer, 0, chunkLen, lastSize);
      fs.closeSync(fd);
      lastSize = newSize;

      const chunk = buffer.toString('utf8');
      if (containsRewardTrigger(chunk)) {
        scheduleRewardTrigger();
      }
    } catch (error) {
      log.error('[EELog] read error:', error.message);
    }
  });

  log.log('[EELog] Watching:', EE_LOG_PATH);
  return EE_LOG_PATH;
}

function stopWatching() {
  clearPendingTrigger();

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  rewardCallback = null;
}

module.exports = {
  startWatching,
  stopWatching,
  EE_LOG_PATH,
};
