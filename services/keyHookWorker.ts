/**
 * Worker thread that installs a low-level keyboard hook (WH_KEYBOARD_LL) so we
 * can trigger overlay hotkeys WITHOUT a system-wide RegisterHotKey grab.
 *
 * Unlike globalShortcut (RegisterHotKey = exclusive), an LL hook is a passive
 * tap on the keystream: we see every key and decide per-key whether to pass it
 * through (CallNextHookEx) or swallow it (return 1). We only swallow a watched
 * combo while Warframe is the FOREGROUND window - so the browser (and every
 * other app) keeps its keys, exactly how Overwolf/Steam/Discord overlays work.
 *
 * WH_KEYBOARD_LL requires the installing thread to pump Windows messages, hence
 * this dedicated worker running a PeekMessage/MsgWaitForMultipleObjectsEx loop
 * (mirrors dbwinWorker's native message loop). The OS invokes the hook callback
 * synchronously on this thread while it waits, and blocks the keystroke until we
 * return - so the callback must stay fast (well under LowLevelHooksTimeout).
 *
 * Shutdown: parent sets stopBuffer[0]=1; the loop notices within WAIT_TICK_MS.
 */

import { workerData, parentPort } from "worker_threads";
import koffi from "koffi";

interface WatchEntry {
  id: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  vk: number;
}

const kernel32 = koffi.load("kernel32.dll");
const user32 = koffi.load("user32.dll");

// Win32 BOOL is a 4-byte int; koffi "bool" is 1 byte and leaves garbage in the
// upper bytes, so any BOOL is declared int32 (same gotcha as dbwinWorker).
const GetModuleHandleW = kernel32.func("GetModuleHandleW", "void *", ["void *"]);
const OpenProcess = kernel32.func("OpenProcess", "void *", ["uint32", "int32", "uint32"]);
const CloseHandle = kernel32.func("CloseHandle", "int32", ["void *"]);
const QueryFullProcessImageNameW = kernel32.func("QueryFullProcessImageNameW", "int32", [
  "void *", // hProcess
  "uint32", // dwFlags - 0 = Win32 path
  "void *", // lpExeName  (PWSTR out buffer)
  "void *", // lpdwSize   (PDWORD in/out)
]);
const GetLastError = kernel32.func("GetLastError", "uint32", []);

const SetWindowsHookExW = user32.func("SetWindowsHookExW", "void *", [
  "int", // idHook
  "void *", // lpfn  (HOOKPROC pointer from koffi.register)
  "void *", // hmod
  "uint32", // dwThreadId - 0 = all threads (global LL hook)
]);
const UnhookWindowsHookEx = user32.func("UnhookWindowsHookEx", "int32", ["void *"]);
const CallNextHookEx = user32.func("CallNextHookEx", "intptr_t", [
  "void *", // hhk (ignored; may be NULL)
  "int", // nCode
  "uintptr_t", // wParam
  "void *", // lParam
]);
const GetForegroundWindow = user32.func("GetForegroundWindow", "void *", []);
const GetWindowThreadProcessId = user32.func("GetWindowThreadProcessId", "uint32", [
  "void *", // hWnd
  "void *", // lpdwProcessId (out)
]);
const GetAsyncKeyState = user32.func("GetAsyncKeyState", "int16", ["int"]);
const PeekMessageW = user32.func("PeekMessageW", "int32", [
  "void *", // lpMsg
  "void *", // hWnd
  "uint32", // wMsgFilterMin
  "uint32", // wMsgFilterMax
  "uint32", // wRemoveMsg
]);
const MsgWaitForMultipleObjectsEx = user32.func("MsgWaitForMultipleObjectsEx", "uint32", [
  "uint32", // nCount
  "void *", // pHandles
  "uint32", // dwMilliseconds
  "uint32", // dwWakeMask
  "uint32", // dwFlags
]);

const KBDLLHOOKSTRUCT = koffi.struct("KBDLLHOOKSTRUCT", {
  vkCode: "uint32",
  scanCode: "uint32",
  flags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr_t",
});
const LowLevelKeyboardProc = koffi.proto("intptr_t LowLevelKeyboardProc(int nCode, uintptr_t wParam, void *lParam)");

const WH_KEYBOARD_LL = 13;
const HC_ACTION = 0;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const PM_REMOVE = 0x0001;
const QS_ALLINPUT = 0x04ff;
const MWMO_INPUTAVAILABLE = 0x0004;
const WAIT_TICK_MS = 200; // how long we block before re-checking the stop flag
const MSG_SIZE = 48; // sizeof(MSG) on x64
const MAX_PATH = 260;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const KEY_DOWN_BIT = 0x8000;

// Modifier virtual-key codes.
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // Alt
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;

// ---- foreground = Warframe? (cached per-PID, refreshed periodically) ----
const _exeNameBuf = Buffer.alloc(MAX_PATH * 2);
const _exeNameSizeBuf = Buffer.alloc(4);
const _pidBuf = Buffer.alloc(4);
const _pidIsWarframe = new Map<number, boolean>();
const PID_CACHE_RESET_MS = 5000;

function isWarframePid(pid: number): boolean {
  const cached = _pidIsWarframe.get(pid);
  if (cached !== undefined) return cached;

  const hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!hProc) return false; // process gone; don't cache

  _exeNameSizeBuf.writeUInt32LE(MAX_PATH, 0);
  const ok = (QueryFullProcessImageNameW(hProc, 0, _exeNameBuf, _exeNameSizeBuf) as number) !== 0;
  CloseHandle(hProc);
  if (!ok) {
    _pidIsWarframe.set(pid, false);
    return false;
  }

  const charCount = _exeNameSizeBuf.readUInt32LE(0);
  const exePath = _exeNameBuf.subarray(0, charCount * 2).toString("utf16le").toLowerCase();
  const result = exePath.endsWith("\\warframe.x64.exe");
  _pidIsWarframe.set(pid, result);
  return result;
}

function foregroundIsWarframe(): boolean {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return false;
  _pidBuf.fill(0);
  GetWindowThreadProcessId(hwnd, _pidBuf);
  const pid = _pidBuf.readUInt32LE(0);
  if (!pid) return false;
  return isWarframePid(pid);
}

// ---- watch list ----
let watchList: WatchEntry[] = normalizeWatch((workerData as { watch?: unknown }).watch);
let watchedVks = new Set(watchList.map((entry) => entry.vk));

function normalizeWatch(value: unknown): WatchEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is WatchEntry => !!v && typeof v.id === "string" && typeof v.vk === "number")
    .map((v) => ({
      id: v.id,
      ctrl: !!v.ctrl,
      alt: !!v.alt,
      shift: !!v.shift,
      win: !!v.win,
      vk: v.vk,
    }));
}

function setWatch(value: unknown): void {
  watchList = normalizeWatch(value);
  watchedVks = new Set(watchList.map((entry) => entry.vk));
}

function down(vk: number): boolean {
  return (GetAsyncKeyState(vk) & KEY_DOWN_BIT) !== 0;
}

function matchBinding(vk: number): WatchEntry | null {
  if (!watchedVks.has(vk)) return null;
  const ctrl = down(VK_CONTROL);
  const alt = down(VK_MENU);
  const shift = down(VK_SHIFT);
  const win = down(VK_LWIN) || down(VK_RWIN);
  for (const entry of watchList) {
    if (
      entry.vk === vk &&
      entry.ctrl === ctrl &&
      entry.alt === alt &&
      entry.shift === shift &&
      entry.win === win
    ) {
      return entry;
    }
  }
  return null;
}

const hookProc = koffi.register((nCode: number, wParam: number, lParam: unknown): number => {
  try {
    if (nCode === HC_ACTION) {
      const message = Number(wParam);
      if (message === WM_KEYDOWN || message === WM_SYSKEYDOWN) {
        const info = koffi.decode(lParam, KBDLLHOOKSTRUCT) as { vkCode: number };
        const match = matchBinding(info.vkCode);
        if (match && foregroundIsWarframe()) {
          parentPort?.postMessage({ type: "hotkey", id: match.id });
          return 1; // swallow: the game (and only the game) loses this key
        }
      }
    }
  } catch {
    // A throwing hook would be silently unhooked by Windows - never let it.
  }
  return CallNextHookEx(null, nCode, wParam as unknown as number, lParam) as number;
}, koffi.pointer(LowLevelKeyboardProc));

const stopFlag = new Int32Array((workerData as { stopBuffer: SharedArrayBuffer }).stopBuffer);
const _msgBuf = Buffer.alloc(MSG_SIZE);

parentPort?.on("message", (m: { type?: string; watch?: unknown }) => {
  if (m?.type === "setWatch") setWatch(m.watch);
});

function run(): void {
  const hHook = SetWindowsHookExW(WH_KEYBOARD_LL, hookProc, GetModuleHandleW(null), 0);
  if (!hHook) {
    parentPort?.postMessage({ type: "error", message: `SetWindowsHookExW failed (GLE=${GetLastError()})` });
    koffi.unregister(hookProc);
    parentPort?.postMessage({ type: "stopped" });
    return;
  }

  parentPort?.postMessage({ type: "ready" });

  let pidCacheResetAt = Date.now() + PID_CACHE_RESET_MS;
  try {
    while (Atomics.load(stopFlag, 0) === 0) {
      // Drain the queue (drives hook delivery); the hook itself also fires while
      // we block in MsgWaitForMultipleObjectsEx below.
      while ((PeekMessageW(_msgBuf, null, 0, 0, PM_REMOVE) as number) !== 0) {
        /* LL hook has no WM_ to dispatch; just keep the queue empty */
      }
      MsgWaitForMultipleObjectsEx(0, null, WAIT_TICK_MS, QS_ALLINPUT, MWMO_INPUTAVAILABLE);

      const now = Date.now();
      if (now > pidCacheResetAt) {
        pidCacheResetAt = now + PID_CACHE_RESET_MS;
        _pidIsWarframe.clear(); // Warframe may have restarted with a new PID
      }
    }
  } finally {
    UnhookWindowsHookEx(hHook);
    koffi.unregister(hookProc);
    parentPort?.postMessage({ type: "stopped" });
  }
}

run();
