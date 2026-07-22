import fs from "node:fs";
import path from "node:path";

import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { WARFRAME_STATUS_CACHE_TTL_MS } from "../config/runtime/cacheConfig";

const log = withScope("warframeStatus");

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PATH = 260;
const PROCESS_SCAN_BUFFER_BYTES = 16_384;
const PROCESS_NAME_CACHE_TTL_MS = 10_000;
const MAX_PROCESS_NAME_CACHE_SIZE = 512;

let _koffi: typeof import("koffi") | null = null;

function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WarframeStatus {
  isOpen: boolean;
  isFocused: boolean;
  processRunning: boolean;
  focusedProcessName: string | null;
  focusedWindowBounds: WindowBounds | null;
  focusedDisplayId: string | null;
  checkedAt: number;
}

let lastStatus: WarframeStatus | null = null;
let lastStatusAt = 0;
let inFlight: Promise<WarframeStatus> | null = null;

/* eslint-disable @typescript-eslint/no-explicit-any -- native FFI bindings are untyped at compile time */
let _win32: {
  GetForegroundWindow: (...args: any[]) => any;
  GetWindowThreadProcessId: (...args: any[]) => any;
  GetWindowRect: (...args: any[]) => any;
  OpenProcess: (...args: any[]) => any;
  CloseHandle: (...args: any[]) => any;
  QueryFullProcessImageNameW: (...args: any[]) => any;
  EnumProcesses: (...args: any[]) => any;
} | null = null;
/* eslint-enable @typescript-eslint/no-explicit-any */
let _win32InitFailed = false;

function ensureWin32(): boolean {
  if (_win32) return true;
  if (_win32InitFailed || process.platform !== "win32") return false;

  try {
    const k = koffi();
    const user32 = k.load("user32.dll");
    const kernel32 = k.load("kernel32.dll");
    const psapi = k.load("psapi.dll");
    _win32 = {
      GetForegroundWindow: user32.func("__stdcall", "GetForegroundWindow", "void *", []),
      GetWindowThreadProcessId: user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", [
        "void *",
        "void *",
      ]),
      // Win32 BOOL is a 4-byte int; koffi "bool" is 1 byte and leaves garbage
      // in the upper bytes of BOOL params - always use int32.
      GetWindowRect: user32.func("__stdcall", "GetWindowRect", "int32", ["void *", "void *"]),
      OpenProcess: kernel32.func("OpenProcess", "void *", ["uint32", "int32", "uint32"]),
      CloseHandle: kernel32.func("CloseHandle", "int32", ["void *"]),
      QueryFullProcessImageNameW: kernel32.func("QueryFullProcessImageNameW", "int32", [
        "void *",
        "uint32",
        "void *",
        "void *",
      ]),
      EnumProcesses: psapi.func("EnumProcesses", "int32", ["void *", "uint32", "void *"]),
    };
    return true;
  } catch (err) {
    _win32InitFailed = true;
    log.warn("[WarframeStatus] native Win32 init failed:", normalizeErrorMessage(err));
    return false;
  }
}

const exeNameBuffer = Buffer.alloc(MAX_PATH * 2);
const exeNameSizeBuffer = Buffer.alloc(4);
const pidsBuffer = Buffer.alloc(PROCESS_SCAN_BUFFER_BYTES);
const pidsUsedBuffer = Buffer.alloc(4);
const foregroundPidBuffer = Buffer.alloc(4);
const foregroundRectBuffer = Buffer.alloc(16);
const processNameCache = new Map<number, { name: string | null; checkedAt: number }>();

function getProcessName(pid: number): string | null {
  if (!ensureWin32() || pid <= 0) return null;
  const now = Date.now();
  const cached = processNameCache.get(pid);
  if (cached && now - cached.checkedAt < PROCESS_NAME_CACHE_TTL_MS) {
    return cached.name;
  }

  const win32 = _win32!;

  const handle = win32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) {
    rememberProcessName(pid, null, now);
    return null;
  }

  try {
    exeNameBuffer.fill(0);
    exeNameSizeBuffer.writeUInt32LE(MAX_PATH, 0);
    const ok = win32.QueryFullProcessImageNameW(handle, 0, exeNameBuffer, exeNameSizeBuffer);
    if (!ok) {
      rememberProcessName(pid, null, now);
      return null;
    }

    const charCount = exeNameSizeBuffer.readUInt32LE(0);
    const exePath = exeNameBuffer.subarray(0, charCount * 2).toString("utf16le");
    const baseName = path.win32.basename(exePath).replace(/\.exe$/i, "");
    const processName = baseName || null;
    rememberProcessName(pid, processName, now);
    return processName;
  } finally {
    win32.CloseHandle(handle);
  }
}

function rememberProcessName(pid: number, name: string | null, checkedAt: number): void {
  if (processNameCache.size >= MAX_PROCESS_NAME_CACHE_SIZE) {
    processNameCache.clear();
  }
  processNameCache.set(pid, { name, checkedAt });
}

function isWarframeProcessName(processName: string | null): boolean {
  return String(processName || "")
    .toLowerCase()
    .includes("warframe");
}

async function isWarframeProcessRunning(): Promise<boolean> {
  try {
    if (!ensureWin32()) return false;
    const win32 = _win32!;

    pidsUsedBuffer.fill(0);
    const ok = win32.EnumProcesses(pidsBuffer, pidsBuffer.length, pidsUsedBuffer);
    if (!ok) return false;

    const pidCount = pidsUsedBuffer.readUInt32LE(0) >>> 2;
    for (let i = 0; i < pidCount; i++) {
      const pid = pidsBuffer.readUInt32LE(i * 4);
      if (pid > 0 && isWarframeProcessName(getProcessName(pid))) return true;
    }
    return false;
  } catch (err) {
    log.warn("[WarframeStatus] process scan failed:", normalizeErrorMessage(err));
    return false;
  }
}

async function getForegroundWindowInfo(): Promise<{
  processName: string | null;
  bounds: WindowBounds | null;
} | null> {
  try {
    if (!ensureWin32()) return null;
    const win32 = _win32!;

    const windowHandle = win32.GetForegroundWindow();
    if (!windowHandle) return null;

    foregroundPidBuffer.fill(0);
    win32.GetWindowThreadProcessId(windowHandle, foregroundPidBuffer);
    const pid = foregroundPidBuffer.readUInt32LE(0);
    if (pid <= 0) return null;

    foregroundRectBuffer.fill(0);
    const hasRect = win32.GetWindowRect(windowHandle, foregroundRectBuffer);
    const left = hasRect ? foregroundRectBuffer.readInt32LE(0) : 0;
    const top = hasRect ? foregroundRectBuffer.readInt32LE(4) : 0;
    const right = hasRect ? foregroundRectBuffer.readInt32LE(8) : 0;
    const bottom = hasRect ? foregroundRectBuffer.readInt32LE(12) : 0;
    return {
      processName: getProcessName(pid),
      bounds: hasRect
        ? {
            x: left,
            y: top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
          }
        : null,
    };
  } catch (err) {
    log.warn("[WarframeStatus] focused process check failed:", normalizeErrorMessage(err));
    return null;
  }
}

function getDisplayIdForBounds(bounds: WindowBounds | null): string | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  try {
    const { screen } = require("electron") as typeof import("electron");
    if (!screen) return null;
    const display = screen.getDisplayMatching(bounds);
    return display ? String(display.id) : null;
  } catch (err) {
    log.warn("[WarframeStatus] display lookup failed:", normalizeErrorMessage(err));
    return null;
  }
}

/**
 * Linux: Warframe runs under Proton/Wine, so Warframe.x64.exe shows up as a
 * regular /proc entry (comm truncates to 15 chars but still contains
 * "warframe").
 */
function isWarframeProcessRunningLinux(): boolean {
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (isWarframeProcessName(fs.readFileSync(`/proc/${entry}/comm`, "utf8"))) return true;
      } catch {
        // process exited mid-scan
      }
    }
  } catch (err) {
    log.warn("[WarframeStatus] /proc scan failed:", normalizeErrorMessage(err));
  }
  return false;
}

function collectStatusLinux(): WarframeStatus {
  const processRunning = isWarframeProcessRunningLinux();
  // There is no portable foreground-window query (X11 vs Wayland). Reward
  // triggers come from the game's own log, so a running game is treated as
  // focused - otherwise every eelog-triggered scan would be skipped.
  return {
    isOpen: processRunning,
    isFocused: processRunning,
    processRunning,
    focusedProcessName: null,
    focusedWindowBounds: null,
    focusedDisplayId: null,
    checkedAt: Date.now(),
  };
}

async function collectStatus(): Promise<WarframeStatus> {
  if (process.platform === "linux") return collectStatusLinux();

  const [processRunning, foregroundWindow] = await Promise.all([
    isWarframeProcessRunning(),
    getForegroundWindowInfo(),
  ]);

  const focusedProcessName = foregroundWindow?.processName || null;
  const isFocused = isWarframeProcessName(focusedProcessName);
  const isOpen = processRunning;
  const focusedWindowBounds = foregroundWindow?.bounds || null;
  const focusedDisplayId = getDisplayIdForBounds(focusedWindowBounds);

  return {
    isOpen,
    isFocused,
    processRunning,
    focusedProcessName,
    focusedWindowBounds,
    focusedDisplayId,
    checkedAt: Date.now(),
  };
}

export async function getStatus(options: { force?: boolean } = {}): Promise<WarframeStatus> {
  const force = !!options.force;
  const now = Date.now();
  if (!force && lastStatus && now - lastStatusAt < WARFRAME_STATUS_CACHE_TTL_MS) {
    return lastStatus;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = collectStatus()
    .catch((err) => {
      log.warn("[WarframeStatus] status collection failed:", normalizeErrorMessage(err));
      return {
        isOpen: false,
        isFocused: false,
        processRunning: false,
        focusedProcessName: null,
        focusedWindowBounds: null,
        focusedDisplayId: null,
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
