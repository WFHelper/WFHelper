"use strict";

const { execFile } = require("node:child_process");

const log = require("./logger").withScope("warframeStatus");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

const STATUS_CACHE_TTL_MS = 900;
const TASKLIST_TIMEOUT_MS = 1200;
const FOCUS_TIMEOUT_MS = 1200;
const WINDOW_CAPTURE_SIZE = Object.freeze({ width: 640, height: 360 });

let lastStatus = null;
let lastStatusAt = 0;
let inFlight = null;

function execFileText(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? ` | ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

async function isWarframeProcessRunning() {
  if (process.platform !== "win32") return false;

  try {
    const out = await execFileText(
      "tasklist",
      ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq Warframe.x64.exe"],
      TASKLIST_TIMEOUT_MS,
    );

    const rows = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return rows.some((row) => row.toLowerCase().includes("warframe.x64.exe"));
  } catch (err) {
    log.warn("[WarframeStatus] tasklist check failed:", normalizeErrorMessage(err));
    return false;
  }
}

async function isWarframeWindowDetected() {
  let desktopCapturer;
  try {
    ({ desktopCapturer } = require("electron"));
  } catch {
    return false;
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: WINDOW_CAPTURE_SIZE,
      fetchWindowIcons: false,
    });

    for (const source of sources) {
      const name = String(source?.name || "").toLowerCase();
      if (!name.includes("warframe")) continue;
      if (name.includes("warframe companion")) continue;
      if (name.includes("ocr crop debugger")) continue;
      return true;
    }

    return false;
  } catch (err) {
    log.warn("[WarframeStatus] window source scan failed:", normalizeErrorMessage(err));
    return false;
  }
}

async function getFocusedProcessName() {
  if (process.platform !== "win32") return null;

  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class WFNative {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    "}",
    '"@',
    "$h=[WFNative]::GetForegroundWindow()",
    "if ($h -eq [IntPtr]::Zero) { '' ; exit 0 }",
    "$pid=0",
    "[WFNative]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null",
    "if ($pid -le 0) { '' ; exit 0 }",
    "try { (Get-Process -Id $pid).ProcessName } catch { '' }",
  ].join("; ");

  try {
    const out = await execFileText(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      FOCUS_TIMEOUT_MS,
    );
    const name = out.trim();
    return name || null;
  } catch (err) {
    log.warn("[WarframeStatus] focused process check failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function collectStatus() {
  const [windowDetected, processRunning, focusedProcessName] = await Promise.all([
    isWarframeWindowDetected(),
    isWarframeProcessRunning(),
    getFocusedProcessName(),
  ]);

  const focusedLow = String(focusedProcessName || "").toLowerCase();
  const isFocused = !focusedProcessName || focusedLow.includes("warframe");
  const isOpen = windowDetected || processRunning;

  return {
    isOpen,
    isFocused,
    windowDetected,
    processRunning,
    focusedProcessName,
    checkedAt: Date.now(),
  };
}

async function getStatus(options = {}) {
  const force = !!options.force;
  const now = Date.now();
  if (!force && lastStatus && now - lastStatusAt < STATUS_CACHE_TTL_MS) {
    return lastStatus;
  }

  if (!force && inFlight) {
    return inFlight;
  }

  inFlight = collectStatus()
    .catch((err) => {
      log.warn("[WarframeStatus] status collection failed:", normalizeErrorMessage(err));
      return {
        isOpen: false,
        isFocused: false,
        windowDetected: false,
        processRunning: false,
        focusedProcessName: null,
        checkedAt: Date.now(),
      };
    })
    .finally(() => {
      inFlight = null;
    });

  lastStatus = await inFlight;
  lastStatusAt = Date.now();
  return lastStatus;
}

module.exports = {
  getStatus,
};
