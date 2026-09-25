import fs from "node:fs";
import path from "node:path";

import { withScope } from "./logger";
import {
  enumProcessNames,
  getProcessSessionId,
  isWarframeExePath,
  queryCommandLine,
  queryExePath,
} from "./win32Process";
import { waylandGameBounds, waylandGameFocus } from "./waylandGameWindow";
import { findWindowBoundsByTitle, isWindowFocusedByTitle } from "./x11WindowQuery";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  WARFRAME_PROCESS_SAMPLE_TTL_MS,
  WARFRAME_STATUS_CACHE_TTL_MS,
} from "../config/runtime/cacheConfig";

const log = withScope("warframeStatus");

const PROCESS_NAME_CACHE_TTL_MS = 10_000;
const MAX_PROCESS_NAME_CACHE_SIZE = 512;

let _koffi: typeof import("koffi") | null = null;

function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

export interface WindowBounds {
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
let lastStatusHadBounds = false;
// One slot per request shape: a shared slot lets either completion free the
// other's, which opens a third probe against a live one.
let inFlightWithBounds: Promise<WarframeStatus> | null = null;
let inFlightWithoutBounds: Promise<WarframeStatus> | null = null;

/* eslint-disable @typescript-eslint/no-explicit-any -- native FFI bindings are untyped at compile time */
let _win32: {
  GetForegroundWindow: () => number | bigint;
  SetForegroundWindow: (handle: bigint) => number;
  GetWindowThreadProcessId: (...args: any[]) => any;
  GetWindowLongW: (...args: any[]) => any;
  GetWindowRect: (...args: any[]) => any;
} | null = null;
/* eslint-enable @typescript-eslint/no-explicit-any */
let _win32InitFailed = false;

function ensureWin32(): boolean {
  if (_win32) return true;
  if (_win32InitFailed || process.platform !== "win32") return false;

  try {
    const k = koffi();
    const user32 = k.load("user32.dll");
    _win32 = {
      GetForegroundWindow: user32.func("__stdcall", "GetForegroundWindow", "uintptr_t", []),
      SetForegroundWindow: user32.func("__stdcall", "SetForegroundWindow", "int32", ["uintptr_t"]),
      GetWindowThreadProcessId: user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", [
        "void *",
        "void *",
      ]),
      GetWindowLongW: user32.func("__stdcall", "GetWindowLongW", "int32", ["uint64", "int32"]),
      // Win32 BOOL is a 4-byte int; koffi "bool" is 1 byte and leaves garbage
      // in the upper bytes of BOOL params - always use int32.
      GetWindowRect: user32.func("__stdcall", "GetWindowRect", "int32", ["void *", "void *"]),
    };
    return true;
  } catch (err) {
    _win32InitFailed = true;
    log.warn("[WarframeStatus] native Win32 init failed:", normalizeErrorMessage(err));
    return false;
  }
}

const foregroundPidBuffer = Buffer.alloc(4);
const foregroundRectBuffer = Buffer.alloc(16);
const processNameCache = new Map<number, { name: string | null; checkedAt: number }>();
let interactionGameWindow: { handle: bigint; pid: number } | null = null;

function windowPid(handle: bigint): number {
  foregroundPidBuffer.fill(0);
  _win32!.GetWindowThreadProcessId(handle, foregroundPidBuffer);
  return foregroundPidBuffer.readUInt32LE(0);
}

function handleMatches(handle: bigint, candidates: Buffer[]): boolean {
  return candidates.some((candidate) => {
    if (candidate.length < 4) return false;
    const value =
      candidate.length >= 8 ? candidate.readBigUInt64LE() : BigInt(candidate.readUInt32LE());
    return value !== 0n && value === handle;
  });
}

export function captureWarframeFocus(): void {
  interactionGameWindow = null;
  try {
    if (!ensureWin32()) return;
    const handle = BigInt(_win32!.GetForegroundWindow());
    if (!handle) return;
    const pid = windowPid(handle);
    const query = queryExePath(pid);
    if (query.status === "ok" && isWarframeExePath(query.path)) {
      interactionGameWindow = { handle, pid };
    }
  } catch {
    // Missing foreground information must not choose a different return target.
  }
}

export function restoreWarframeFocus(overlayHandles: Buffer[]): boolean {
  const target = interactionGameWindow;
  interactionGameWindow = null;
  try {
    if (!target || !ensureWin32()) return false;
    const foreground = BigInt(_win32!.GetForegroundWindow());
    if (!handleMatches(foreground, overlayHandles)) return false;
    if (windowPid(target.handle) !== target.pid) return false;
    const query = queryExePath(target.pid);
    if (query.status !== "ok" || !isWarframeExePath(query.path)) return false;
    const restored = !!_win32!.SetForegroundWindow(target.handle);
    log.info(`[OverlayFocus] returned to Warframe=${restored}`);
    return restored;
  } catch (error) {
    log.warn("[OverlayFocus] return failed:", normalizeErrorMessage(error));
    return false;
  }
}

export function isWarframeOrWindowForeground(handles: Buffer[]): boolean | null {
  try {
    if (!ensureWin32()) return null;
    const foreground = BigInt(_win32!.GetForegroundWindow());
    if (!foreground) return false;
    if (handleMatches(foreground, handles)) return true;
    return getProcessName(windowPid(foreground))?.toLowerCase() === "warframe.x64";
  } catch {
    return null;
  }
}

function getProcessName(pid: number): string | null {
  if (pid <= 0) return null;
  const now = Date.now();
  const cached = processNameCache.get(pid);
  if (cached && now - cached.checkedAt < PROCESS_NAME_CACHE_TTL_MS) {
    return cached.name;
  }

  const query = queryExePath(pid);
  const processName =
    query.status === "ok" ? path.win32.basename(query.path).replace(/\.exe$/i, "") || null : null;
  rememberProcessName(pid, processName, now);
  return processName;
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

// Warframe's launcher runs Warframe.x64.exe with -applet: for its content update.
function readWarframeProcessKind(pid: number): "game" | "applet" | "exiting" {
  const result = queryCommandLine(pid);
  if (result.status === "exiting") return "exiting";
  if (result.status !== "ok") return "game";
  return result.commandLine.toLowerCase().includes("-applet:") ? "applet" : "game";
}

let lastProcessSample: { running: boolean | null; at: number } | null = null;

/** Exact game in this Windows session; unknown never confirms an exit. */
export function getWarframeProcessState(force = false): boolean | null {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (!force && lastProcessSample && now - lastProcessSample.at < WARFRAME_PROCESS_SAMPLE_TTL_MS) {
    return lastProcessSample.running;
  }
  let running: boolean | null = null;
  try {
    const session = getProcessSessionId(process.pid);
    if (session != null) {
      const processes = enumProcessNames();
      let unknown = processes == null;
      let found = false;
      const candidates = (processes ?? []).filter(
        ({ name }) => name.toLowerCase() === "warframe.x64.exe",
      );
      for (const { pid } of candidates) {
        const processSession = getProcessSessionId(pid);
        if (processSession == null) {
          unknown = true;
          continue;
        }
        // Read on every sample: an applet can take over an exited game's pid
        // before any sample misses that pid.
        if (processSession !== session || readWarframeProcessKind(pid) !== "game") continue;
        found = true;
        break;
      }
      running = found ? true : unknown ? null : false;
    }
  } catch (err) {
    log.warn("[WarframeStatus] process scan failed:", normalizeErrorMessage(err));
  }
  lastProcessSample = { running, at: now };
  return running;
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

/** No process scan, no bounds and no cache, so it can be asked often. Null = unknowable. */
export function isWarframeForegroundNow(): boolean | null {
  if (process.platform === "linux") return isWarframeWindowFocusedLinux();
  if (process.platform !== "win32") return null;
  try {
    if (!ensureWin32()) return null;
    const win32 = _win32!;
    const windowHandle = win32.GetForegroundWindow();
    if (!windowHandle) return null;
    foregroundPidBuffer.fill(0);
    win32.GetWindowThreadProcessId(windowHandle, foregroundPidBuffer);
    const pid = foregroundPidBuffer.readUInt32LE(0);
    if (pid <= 0) return null;
    return isWarframeProcessName(getProcessName(pid));
  } catch (err) {
    log.warn("[WarframeStatus] foreground focus check failed:", normalizeErrorMessage(err));
    return null;
  }
}

/** Whether the OS foreground window belongs to this process (win32 only, else
 * null). Electron's getFocusedWindow can wedge on a stale window after a
 * focused overlay is made unfocusable; the foreground pid is the authority. */
export function isOwnProcessForeground(): boolean | null {
  if (process.platform !== "win32") return null;
  try {
    if (!ensureWin32()) return null;
    const win32 = _win32!;
    const windowHandle = win32.GetForegroundWindow();
    if (!windowHandle) return null;
    foregroundPidBuffer.fill(0);
    win32.GetWindowThreadProcessId(windowHandle, foregroundPidBuffer);
    const pid = foregroundPidBuffer.readUInt32LE(0);
    if (pid <= 0) return null;
    return pid === process.pid;
  } catch {
    return null;
  }
}

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x0000_0008;

/** Live WS_EX_TOPMOST read for a getNativeWindowHandle() buffer; null =
 * unknowable (off-windows or the read failed). */
export function isWindowTopmost(handle: Buffer): boolean | null {
  if (process.platform !== "win32" || handle.length < 4) return null;
  try {
    if (!ensureWin32()) return null;
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    if (hwnd === 0n) return null;
    const style = Number(_win32!.GetWindowLongW(hwnd, GWL_EXSTYLE));
    // 0 = failed read or a style-less window; overlays always carry ex-styles,
    // so report unknown rather than "not topmost".
    if (style === 0) return null;
    return (style & WS_EX_TOPMOST) !== 0;
  } catch {
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

/** Proton exposes Warframe as a regular, truncated /proc comm entry. */
function isWarframeProcessRunningLinux(): boolean | null {
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
    return null;
  }
  return false;
}

// Matches `0xID "name": ("res" "class")  WxH+rx+ry  +absX+absY` from xwininfo
// -root -tree; the trailing +absX+absY is what maps the window to a display.
const XWININFO_WINDOW_RE =
  /^\s*0x[0-9a-f]+\s+("[^"]*"|\(has no name\)):\s+\(([^)]*)\)\s+(\d+)x(\d+)\+-?\d+\+-?\d+\s+\+(-?\d+)\+(-?\d+)/i;
const MIN_GAME_WINDOW_EDGE_PX = 200;
const LINUX_WINDOW_PROBE_TIMEOUT_MS = 1_500;

/** Largest Warframe-looking window in an `xwininfo -root -tree` dump. */
export function parseWarframeWindowBounds(treeOutput: string): WindowBounds | null {
  let best: WindowBounds | null = null;

  for (const line of String(treeOutput || "").split("\n")) {
    const match = XWININFO_WINDOW_RE.exec(line);
    if (!match) continue;
    if (!/warframe/i.test(`${match[1]} ${match[2]}`)) continue;

    const bounds = {
      x: Number(match[5]),
      y: Number(match[6]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
    // Wine also maps tiny helper windows; the game is the biggest one.
    if (bounds.width < MIN_GAME_WINDOW_EDGE_PX || bounds.height < MIN_GAME_WINDOW_EDGE_PX) continue;
    if (!best || bounds.width * bounds.height > best.width * best.height) best = bounds;
  }

  return best;
}

let _linuxWindowProbeUnavailable = false;
let _loggedGeometrySource: string | null = null;
const WARFRAME_WINDOW_TITLE_RE = /warframe/i;

// Named once per source so a support log says where the placement came from.
function noteGeometrySource(source: string, bounds: WindowBounds): WindowBounds {
  if (_loggedGeometrySource !== source) {
    _loggedGeometrySource = source;
    log.info(
      `[WarframeStatus] game window via ${source}: ${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`,
    );
  }
  return bounds;
}

/** Focus read for the overlay unfocus-hide, which the permissive status poll
 * cannot answer. A native wayland game has no X11 window, so the compositor is
 * asked first. Null = unknowable, callers treat as focused. */
export function isWarframeWindowFocusedLinux(): boolean | null {
  const wayland = waylandGameFocus();
  if (wayland !== null) return wayland;
  if (!process.env.DISPLAY) return null;
  const focused = isWindowFocusedByTitle(WARFRAME_WINDOW_TITLE_RE);
  if (focused !== false) return focused;
  // GNOME leaves _NET_ACTIVE_WINDOW at 0 for a native wayland game, so a false
  // only means "not focused" if the game has an X11 window to lose focus.
  return hasX11GameWindow() ? false : null;
}

const X11_PRESENCE_TTL_MS = 10_000;
let _x11GameWindowAt = 0;
let _x11GameWindow = false;

function hasX11GameWindow(): boolean {
  const now = Date.now();
  if (now - _x11GameWindowAt < X11_PRESENCE_TTL_MS) return _x11GameWindow;
  _x11GameWindowAt = now;
  _x11GameWindow =
    findWindowBoundsByTitle(WARFRAME_WINDOW_TITLE_RE, MIN_GAME_WINDOW_EDGE_PX) !== null;
  return _x11GameWindow;
}

/** X11 first: a window under XWayland is also visible to the wayland sources,
 * but only X11 reports its real geometry rather than the output it covers. */
export async function getWarframeWindowBoundsLinux(): Promise<WindowBounds | null> {
  const x11 = await getWarframeWindowBoundsX11();
  if (x11) return x11;

  const wayland = await waylandGameBounds();
  if (!wayland) return null;
  const { source, ...bounds } = wayland;
  return noteGeometrySource(source, bounds);
}

async function getWarframeWindowBoundsX11(): Promise<WindowBounds | null> {
  if (!process.env.DISPLAY) return null;

  // libX11 needs nothing installed; xwininfo is the fallback because it also
  // matches WM_CLASS, which helps if the title is localised or empty.
  const native = findWindowBoundsByTitle(WARFRAME_WINDOW_TITLE_RE, MIN_GAME_WINDOW_EDGE_PX);
  if (native) return noteGeometrySource("libX11", native);
  if (_linuxWindowProbeUnavailable) return null;

  try {
    const { execFile } = require("node:child_process") as typeof import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "xwininfo",
        ["-root", "-tree"],
        { timeout: LINUX_WINDOW_PROBE_TIMEOUT_MS, maxBuffer: 8_000_000 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    const parsed = parseWarframeWindowBounds(stdout);
    return parsed ? noteGeometrySource("xwininfo", parsed) : null;
  } catch (err) {
    // No xwininfo (x11-utils) or no X server - overlays fall back to cursor placement.
    _linuxWindowProbeUnavailable = true;
    log.warn(
      "[WarframeStatus] xwininfo probe unavailable, overlays use cursor placement:",
      normalizeErrorMessage(err),
    );
    return null;
  }
}

let lastKnownPresence: { running: boolean; at: number } | null = null;

// An unknown sample must not read as an exit: it would unregister the overlay
// hotkeys and flip warframe.market presence to invisible mid-session.
function presenceFromSample(sampled: boolean | null): boolean {
  if (sampled === null) return lastStatus?.processRunning ?? false;
  lastKnownPresence = { running: sampled, at: Date.now() };
  return sampled;
}

async function collectStatusLinux(needBounds: boolean): Promise<WarframeStatus> {
  const processRunning = presenceFromSample(isWarframeProcessRunningLinux());
  // Warframe is an XWayland client under Proton, so its X geometry is readable
  // on both session types; focus itself has no portable query. The probe walks
  // the X tree, so pollers that only read isFocused skip it.
  const focusedWindowBounds =
    processRunning && needBounds ? await getWarframeWindowBoundsLinux() : null;
  return {
    isOpen: processRunning,
    isFocused: processRunning,
    processRunning,
    focusedProcessName: null,
    focusedWindowBounds,
    focusedDisplayId: getDisplayIdForBounds(focusedWindowBounds),
    checkedAt: Date.now(),
  };
}

async function collectStatus(
  needBounds: boolean,
  forceProcessScan: boolean,
): Promise<WarframeStatus> {
  if (process.platform === "linux") return collectStatusLinux(needBounds);

  const [sampledRunning, foregroundWindow] = await Promise.all([
    getWarframeProcessState(forceProcessScan),
    getForegroundWindowInfo(),
  ]);
  const processRunning = presenceFromSample(sampledRunning);

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

// The hotkey gate polls getStatus every 3s for the whole app lifetime; beyond
// this the last reading is treated as unknown rather than as an exit.
const RUNNING_CACHE_MAX_AGE_MS = 30_000;

/** Last polled presence of the game, sampling nothing: callers on the
 *  notification path must not trigger a process scan. Null = unknown, which
 *  never means the game is closed. */
export function isWarframeRunningCached(): boolean | null {
  if (!lastKnownPresence || Date.now() - lastKnownPresence.at > RUNNING_CACHE_MAX_AGE_MS) {
    return null;
  }
  return lastKnownPresence.running;
}

/** `keepProcessSample` leaves the process scan on its own TTL even under `force`. */
export async function getStatus(
  options: { force?: boolean; needBounds?: boolean; keepProcessSample?: boolean } = {},
): Promise<WarframeStatus> {
  const force = !!options.force;
  const forceProcessScan = force && options.keepProcessSample !== true;
  // Bounds-free results are cached too, so a caller that needs geometry must
  // not be served one; it collects again instead of inheriting a null. Only
  // linux can skip the probe, so elsewhere every result is bounds-complete.
  const needBounds = options.needBounds !== false;
  const willHaveBounds = needBounds || process.platform !== "linux";
  const now = Date.now();
  const cacheUsable = lastStatus && (lastStatusHadBounds || !needBounds);
  if (!force && cacheUsable && now - lastStatusAt < WARFRAME_STATUS_CACHE_TTL_MS) {
    return lastStatus as WarframeStatus;
  }

  // A bounds-complete probe already answers a bounds-free caller.
  const joinable = inFlightWithBounds ?? (needBounds ? null : inFlightWithoutBounds);
  if (joinable) return joinable;

  const collected = collectStatus(needBounds, forceProcessScan).catch((err) => {
    log.warn("[WarframeStatus] status collection failed:", normalizeErrorMessage(err));
    if (lastStatus) return { ...lastStatus, checkedAt: Date.now() };
    return {
      isOpen: false,
      isFocused: false,
      processRunning: false,
      focusedProcessName: null,
      focusedWindowBounds: null,
      focusedDisplayId: null,
      checkedAt: Date.now(),
    };
  });
  if (willHaveBounds) inFlightWithBounds = collected;
  else inFlightWithoutBounds = collected;

  const status = await collected;
  // Identity guard: a later request may already own the slot.
  if (inFlightWithBounds === collected) inFlightWithBounds = null;
  if (inFlightWithoutBounds === collected) inFlightWithoutBounds = null;

  // A bounds-free result landing after a bounds-complete peer must not drop its
  // geometry from the cache.
  const downgradesFresher =
    lastStatus != null &&
    lastStatusHadBounds &&
    !willHaveBounds &&
    status.checkedAt <= lastStatus.checkedAt;
  if (!downgradesFresher) {
    lastStatus = status;
    lastStatusAt = Date.now();
    lastStatusHadBounds = willHaveBounds;
  }
  return status;
}
