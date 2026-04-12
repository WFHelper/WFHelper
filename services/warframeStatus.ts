import { execFile } from "node:child_process";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("warframeStatus");

/** Throttle repeated isWarframeRunning queries — 2 s keeps UI responsive without hammering tasklist. */
const STATUS_CACHE_TTL_MS = 2000;
/** Kill tasklist.exe if it hangs longer than this — prevents zombie processes on locked PCs. */
const TASKLIST_TIMEOUT_MS = 1200;
/** Kill the foreground-window check after this long to avoid blocking the overlay loop. */
const FOCUS_TIMEOUT_MS = 1200;

function getElectronScreen(): any {
  try {
    const { screen } = require("electron") as typeof import("electron");
    return screen || null;
  } catch {
    return null;
  }
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

function execFileText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? ` | ${String(stderr).trim()}` : ""}`));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

async function isWarframeProcessRunning(): Promise<boolean> {
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

async function getForegroundWindowInfo(): Promise<{
  processName: string | null;
  bounds: WindowBounds | null;
} | null> {
  if (process.platform !== "win32") return null;

  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class WFNative {",
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    "}",
    '"@',
    "$h=[WFNative]::GetForegroundWindow()",
    "if ($h -eq [IntPtr]::Zero) { exit 0 }",
    "$procId=0",
    "[WFNative]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null",
    "if ($procId -le 0) { exit 0 }",
    "$name=''",
    "try { $name=(Get-Process -Id $procId).ProcessName } catch { $name='' }",
    "$rect=New-Object WFNative+RECT",
    "$bounds=$null",
    "if ([WFNative]::GetWindowRect($h, [ref]$rect)) {",
    "  $bounds=@{ x=[int]$rect.Left; y=[int]$rect.Top; width=[int]($rect.Right-$rect.Left); height=[int]($rect.Bottom-$rect.Top) }",
    "}",
    "$result=@{ processName=$name; bounds=$bounds }",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");

  try {
    const out = await execFileText(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      FOCUS_TIMEOUT_MS,
    );
    const trimmed = out.trim();
    if (!trimmed) return null;

    const parsed = JSON.parse(trimmed) as any;
    const processName = typeof parsed?.processName === "string" ? parsed.processName.trim() : "";
    const bounds = parsed?.bounds;

    return {
      processName: processName || null,
      bounds:
        bounds &&
        Number.isFinite(bounds.x) &&
        Number.isFinite(bounds.y) &&
        Number.isFinite(bounds.width) &&
        Number.isFinite(bounds.height)
          ? {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.max(0, Math.round(bounds.width)),
              height: Math.max(0, Math.round(bounds.height)),
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

  const screenApi = getElectronScreen();
  if (!screenApi) return null;

  try {
    const display = screenApi.getDisplayMatching(bounds);
    return display ? String(display.id) : null;
  } catch (err) {
    log.warn("[WarframeStatus] display lookup failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function collectStatus(): Promise<WarframeStatus> {
  const [processRunning, foregroundWindow] = await Promise.all([
    isWarframeProcessRunning(),
    getForegroundWindowInfo(),
  ]);

  const focusedProcessName = foregroundWindow?.processName || null;
  const focusedLow = String(focusedProcessName || "").toLowerCase();
  const isFocused = !focusedProcessName || focusedLow.includes("warframe");
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