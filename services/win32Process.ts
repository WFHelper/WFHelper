/** One home for the OpenProcess -> QueryFullProcessImageNameW dance. It was
 * hand-copied into four modules, and a wrong koffi signature kills Electron
 * silently instead of throwing. */

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PATH = 260;
const PROCESS_SCAN_BUFFER_BYTES = 16_384;
const TH32CS_SNAPPROCESS = 0x2;
const ERROR_NO_MORE_FILES = 18;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const STATUS_PROCESS_IS_TERMINATING = 0xc000010a;
const MAX_COMMAND_LINE_BYTES = 65_534;

const WARFRAME_EXE_SUFFIX = "\\warframe.x64.exe";

// Lazy so the module still loads where koffi is missing or irrelevant.
let _koffi: typeof import("koffi") | null = null;
function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- native FFI bindings */
type NativeFn = (...args: any[]) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let _api: {
  OpenProcess: NativeFn;
  CloseHandle: NativeFn;
  QueryFullProcessImageNameW: NativeFn;
  EnumProcesses: NativeFn;
  ProcessIdToSessionId: NativeFn;
  CreateToolhelp32Snapshot: NativeFn;
  Process32FirstW: NativeFn;
  Process32NextW: NativeFn;
  GetLastError: NativeFn;
} | null = null;
let _apiFailed = false;
let _processEntryLayout: { size: number; pid: number; name: number } | null = null;
let _ntQueryInformationProcess: NativeFn | null = null;
let _ntQueryFailed = false;
let _unicodeStringBytes = 0;

function api(): typeof _api {
  if (_api) return _api;
  // Guard before koffi: the callers this replaced all checked the platform
  // first, so nothing off Windows ever tried to load kernel32.
  if (_apiFailed || process.platform !== "win32") return null;
  try {
    const k = koffi();
    const kernel32 = k.load("kernel32.dll");
    const psapi = k.load("psapi.dll");
    const processEntry = k.struct({
      dwSize: "uint32",
      cntUsage: "uint32",
      th32ProcessID: "uint32",
      th32DefaultHeapID: "uintptr_t",
      th32ModuleID: "uint32",
      cntThreads: "uint32",
      th32ParentProcessID: "uint32",
      pcPriClassBase: "int32",
      dwFlags: "uint32",
      szExeFile: k.array("uint16", MAX_PATH),
    });
    _processEntryLayout = {
      size: k.sizeof(processEntry),
      pid: k.offsetof(processEntry, "th32ProcessID"),
      name: k.offsetof(processEntry, "szExeFile"),
    };
    _api = {
      OpenProcess: kernel32.func("OpenProcess", "void *", ["uint32", "int32", "uint32"]),
      CloseHandle: kernel32.func("CloseHandle", "int32", ["void *"]),
      QueryFullProcessImageNameW: kernel32.func("QueryFullProcessImageNameW", "int32", [
        "void *",
        "uint32",
        "void *",
        "void *",
      ]),
      EnumProcesses: psapi.func("EnumProcesses", "int32", ["void *", "uint32", "void *"]),
      ProcessIdToSessionId: kernel32.func("ProcessIdToSessionId", "int32", ["uint32", "void *"]),
      CreateToolhelp32Snapshot: kernel32.func("CreateToolhelp32Snapshot", "intptr_t", [
        "uint32",
        "uint32",
      ]),
      Process32FirstW: kernel32.func("Process32FirstW", "int32", ["intptr_t", "void *"]),
      Process32NextW: kernel32.func("Process32NextW", "int32", ["intptr_t", "void *"]),
      GetLastError: kernel32.func("GetLastError", "uint32", []),
    };
    return _api;
  } catch {
    _apiFailed = true;
    return null;
  }
}

const _exeNameBuf = Buffer.alloc(MAX_PATH * 2);
const _exeNameSizeBuf = Buffer.alloc(4);
const _pidsBuf = Buffer.alloc(PROCESS_SCAN_BUFFER_BYTES);
const _pidsUsedBuf = Buffer.alloc(4);
let _commandLineBuf: Buffer | null = null;

/** Callers cache these differently, so the two failures stay distinguishable:
 * a process that is gone may be Warframe next time, one that refuses to
 * answer will refuse again. */
type ExePathResult =
  | { status: "ok"; path: string }
  | { status: "unreachable" }
  | { status: "unknown" };

export function queryExePath(pid: number): ExePathResult {
  const win32 = api();
  if (!win32 || pid <= 0) return { status: "unreachable" };

  const handle = win32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return { status: "unreachable" };

  try {
    _exeNameSizeBuf.writeUInt32LE(MAX_PATH, 0);
    const ok =
      (win32.QueryFullProcessImageNameW(handle, 0, _exeNameBuf, _exeNameSizeBuf) as number) !== 0;
    if (!ok) return { status: "unknown" };
    const charCount = _exeNameSizeBuf.readUInt32LE(0);
    return { status: "ok", path: _exeNameBuf.subarray(0, charCount * 2).toString("utf16le") };
  } finally {
    win32.CloseHandle(handle);
  }
}

type CommandLineResult =
  | { status: "ok"; commandLine: string }
  | { status: "exiting" }
  | { status: "unreadable" };

/** Bound on first use, so a process that never reads a command line never binds ntdll. */
function ntQueryInformationProcess(): NativeFn | null {
  if (_ntQueryInformationProcess || _ntQueryFailed) return _ntQueryInformationProcess;
  try {
    const k = koffi();
    _unicodeStringBytes = 2 * k.sizeof("void *");
    _ntQueryInformationProcess = k
      .load("ntdll.dll")
      .func("NtQueryInformationProcess", "int32", [
        "void *",
        "int32",
        "void *",
        "uint32",
        "void *",
      ]);
  } catch {
    _ntQueryFailed = true;
  }
  return _ntQueryInformationProcess;
}

export function queryCommandLine(pid: number): CommandLineResult {
  const win32 = api();
  const query = win32 ? ntQueryInformationProcess() : null;
  if (!win32 || !query || pid <= 0) return { status: "unreadable" };

  const handle = win32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return { status: "unreadable" };

  try {
    _commandLineBuf ??= Buffer.alloc(_unicodeStringBytes + MAX_COMMAND_LINE_BYTES);
    const status = Number(
      query(
        handle,
        PROCESS_COMMAND_LINE_INFORMATION,
        _commandLineBuf,
        _commandLineBuf.length,
        null,
      ),
    );
    if (status >>> 0 === STATUS_PROCESS_IS_TERMINATING) return { status: "exiting" };
    if (status < 0) return { status: "unreadable" };
    const bytes = _commandLineBuf.readUInt16LE(0);
    return {
      status: "ok",
      commandLine: _commandLineBuf
        .subarray(_unicodeStringBytes, _unicodeStringBytes + bytes)
        .toString("utf16le"),
    };
  } finally {
    win32.CloseHandle(handle);
  }
}

export function exePathOfPid(pid: number): string | null {
  const result = queryExePath(pid);
  return result.status === "ok" ? result.path : null;
}

export function isWarframeExePath(exePath: string | null | undefined): boolean {
  return typeof exePath === "string" && exePath.toLowerCase().endsWith(WARFRAME_EXE_SUFFIX);
}

export function enumProcessIds(): number[] {
  const win32 = api();
  if (!win32) return [];
  if ((win32.EnumProcesses(_pidsBuf, _pidsBuf.length, _pidsUsedBuf) as number) === 0) return [];
  const count = _pidsUsedBuf.readUInt32LE(0) >>> 2;
  const pids: number[] = [];
  for (let i = 0; i < count; i++) {
    const pid = _pidsBuf.readUInt32LE(i * 4);
    if (pid > 0) pids.push(pid);
  }
  return pids;
}

export function getProcessSessionId(pid: number): number | null {
  const win32 = api();
  if (!win32 || pid <= 0) return null;
  const session = Buffer.alloc(4);
  return win32.ProcessIdToSessionId(pid, session) ? session.readUInt32LE(0) : null;
}

/** Toolhelp names do not require opening protected or elevated processes. */
export function enumProcessNames(): { pid: number; name: string }[] | null {
  const win32 = api();
  const layout = _processEntryLayout;
  if (!win32 || !layout) return null;
  const snapshot = win32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot === -1 || snapshot === -1n) return null;
  try {
    const entry = Buffer.alloc(layout.size);
    entry.writeUInt32LE(layout.size, 0);
    if (!win32.Process32FirstW(snapshot, entry)) return null;
    const processes: { pid: number; name: string }[] = [];
    do {
      processes.push({
        pid: entry.readUInt32LE(layout.pid),
        name: entry
          .subarray(layout.name, layout.name + MAX_PATH * 2)
          .toString("utf16le")
          .split("\0", 1)[0],
      });
    } while (win32.Process32NextW(snapshot, entry));
    return win32.GetLastError() === ERROR_NO_MORE_FILES ? processes : null;
  } finally {
    win32.CloseHandle(snapshot);
  }
}
