"use strict";

/**
 * eeLogMonitor.js — Warframe EE.log tail watcher
 *
 * Watches Warframe's real-time log for "Got rewards" trigger lines that
 * indicate a relic was just opened. Only reads new bytes appended since
 * the watcher started (does NOT scan the entire existing log).
 */

const fs       = require("fs");
const path     = require("path");
const chokidar = require("chokidar");

const EE_LOG_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Warframe", "EE.log")
  : null;

// Trigger phrase seen in Warframe's EE.log when a relic reward screen appears
const REWARD_RE = /Script\s+\[Info\].*Got\s+rewards/i;

let watcher   = null;
let lastSize  = 0;
let _callback = null;

/**
 * Start watching EE.log for reward triggers.
 * @param {Function} onReward - called each time a relic reward screen is detected
 * @returns {string|null} the path being watched, or null if not available
 */
function startWatching(onReward) {
  if (!EE_LOG_PATH) {
    console.warn("[EELog] LOCALAPPDATA not set — EE.log monitoring unavailable");
    return null;
  }
  if (!fs.existsSync(EE_LOG_PATH)) {
    console.warn("[EELog] EE.log not found at:", EE_LOG_PATH);
    return null;
  }

  _callback = onReward;

  // Record current file size; we only process new bytes from here onwards
  try {
    lastSize = fs.statSync(EE_LOG_PATH).size;
  } catch {
    lastSize = 0;
  }

  if (watcher) watcher.close();

  watcher = chokidar.watch(EE_LOG_PATH, {
    persistent:      true,
    usePolling:      false,
    awaitWriteFinish: false,
  });

  watcher.on("change", () => {
    try {
      const newSize = fs.statSync(EE_LOG_PATH).size;
      if (newSize <= lastSize) {
        // File was truncated (new session) — reset position
        lastSize = newSize;
        return;
      }

      const chunkLen = newSize - lastSize;
      const buf = Buffer.alloc(chunkLen);
      const fd  = fs.openSync(EE_LOG_PATH, "r");
      fs.readSync(fd, buf, 0, chunkLen, lastSize);
      fs.closeSync(fd);
      lastSize = newSize;

      const chunk = buf.toString("utf8");
      if (REWARD_RE.test(chunk)) {
        console.log("[EELog] Relic reward trigger detected");
        _callback && _callback();
      }
    } catch (err) {
      console.error("[EELog] read error:", err.message);
    }
  });

  console.log("[EELog] Watching:", EE_LOG_PATH);
  return EE_LOG_PATH;
}

/**
 * Stop watching EE.log.
 */
function stopWatching() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  _callback = null;
}

module.exports = { startWatching, stopWatching, EE_LOG_PATH };
