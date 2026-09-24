/** DBWIN readers must create the shared objects before writers can emit.
 * Keep them absent while Warframe is closed so the worker can sleep. */

import { workerData, parentPort } from "worker_threads";
import koffi from "koffi";
import { DebugLineGate } from "./debugLineFilter";
import { enumProcessIds, isWarframeExePath, queryExePath } from "./win32Process";

const kernel32 = koffi.load("kernel32.dll");

const CreateFileMappingW = kernel32.func("CreateFileMappingW", "void *", [
  "void *", // hFile            - INVALID_HANDLE_VALUE (-1n) for pagefile-backed
  "void *", // lpAttributes     - NULL
  "uint32", // flProtect        - PAGE_READWRITE
  "uint32", // dwMaximumSizeHigh
  "uint32", // dwMaximumSizeLow
  "str16", // lpName
]);

const MapViewOfFile = kernel32.func("MapViewOfFile", "void *", [
  "void *", // hFileMappingObject
  "uint32", // dwDesiredAccess
  "uint32", // dwFileOffsetHigh
  "uint32", // dwFileOffsetLow
  "size_t", // dwNumberOfBytesToMap - 0 = map the whole thing
]);

// Win32 BOOL is a 4-byte int. koffi's "bool" is 1 byte and leaves garbage in
// the upper bytes, so BOOL params read as TRUE regardless - always use int32.
const UnmapViewOfFile = kernel32.func("UnmapViewOfFile", "int32", ["void *"]);

const CreateEventW = kernel32.func("CreateEventW", "void *", [
  "void *", // lpEventAttributes - NULL
  "int32", // bManualReset  (BOOL)
  "int32", // bInitialState (BOOL)
  "str16", // lpName
]);

const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", [
  "void *", // hHandle
  "uint32", // dwMilliseconds
]);

const SetEvent = kernel32.func("SetEvent", "int32", ["void *"]);
const CloseHandle = kernel32.func("CloseHandle", "int32", ["void *"]);
const GetLastError = kernel32.func("GetLastError", "uint32", []);
const GetCurrentThread = kernel32.func("GetCurrentThread", "void *", []);
const SetThreadPriority = kernel32.func("SetThreadPriority", "int32", ["void *", "int32"]);

const PAGE_READWRITE = 0x04;
const FILE_MAP_READ = 0x0004;
const WAIT_OBJECT_0 = 0;
const ERROR_ALREADY_EXISTS = 183;
const DBWIN_BUFFER_SIZE = 4096;
// INVALID_HANDLE_VALUE = (HANDLE)(-1) = 0xFFFF_FFFF_FFFF_FFFF on 64-bit
const INVALID_HANDLE_VALUE = -1n;
const WAIT_TIMEOUT_MS = 500;
const THREAD_PRIORITY_HIGHEST = 2;
const WARFRAME_POLL_MS = 2000;
const WARFRAME_RECHECK_MS = 5000;
// Decoded as a typed-array COPY into V8 memory. koffi.view() is a fatal napi
// error under Electron's memory cage (no external ArrayBuffers) - never use it.
const uint8ArrayType = koffi.array("uint8", DBWIN_BUFFER_SIZE, "Typed");

const lineGate = new DebugLineGate();

const _pidIsWarframe = new Map<number, boolean>();
const MAX_PID_CACHE_SIZE = 256;

function rememberPid(pid: number, value: boolean): void {
  if (_pidIsWarframe.size >= MAX_PID_CACHE_SIZE) {
    _pidIsWarframe.clear();
  }
  _pidIsWarframe.set(pid, value);
}

function isWarframePid(pid: number): boolean {
  const cached = _pidIsWarframe.get(pid);
  if (cached !== undefined) return cached;

  const query = queryExePath(pid);
  // Process may have exited; treat as not Warframe and don't cache.
  if (query.status === "unreachable") return false;

  const result = query.status === "ok" && isWarframeExePath(query.path);
  rememberPid(pid, result);
  return result;
}

function isWarframeRunning(): boolean {
  return enumProcessIds().some(isWarframePid);
}

const { stopBuffer, dbwinPrefix = "DBWIN" } = workerData as {
  stopBuffer: SharedArrayBuffer;
  dbwinPrefix?: string;
};
const stopFlag = new Int32Array(stopBuffer);

function runDbwinLoop(): void {
  // Create DBWIN_BUFFER (pagefile-backed, writable so the sender can use it)
  const hMap = CreateFileMappingW(
    INVALID_HANDLE_VALUE,
    null,
    PAGE_READWRITE,
    0,
    DBWIN_BUFFER_SIZE,
    `${dbwinPrefix}_BUFFER`,
  );

  if (!hMap) {
    parentPort?.postMessage({
      type: "error",
      message: `CreateFileMappingW failed (GLE=${GetLastError()})`,
    });
    return;
  }

  const alreadyExists = GetLastError() === ERROR_ALREADY_EXISTS;

  const pBuf = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
  if (!pBuf) {
    parentPort?.postMessage({
      type: "error",
      message: `MapViewOfFile failed (GLE=${GetLastError()})`,
    });
    CloseHandle(hMap);
    return;
  }

  // DBWIN_BUFFER_READY: auto-reset (0), initially signaled (1) - "ready to receive"
  const hReady = CreateEventW(null, 0, 1, `${dbwinPrefix}_BUFFER_READY`);
  // DBWIN_DATA_READY:  auto-reset (0), initially unsignaled (0)
  const hData = CreateEventW(null, 0, 0, `${dbwinPrefix}_DATA_READY`);

  if (!hReady || !hData) {
    parentPort?.postMessage({
      type: "error",
      message: `CreateEventW failed (GLE=${GetLastError()})`,
    });
    UnmapViewOfFile(pBuf);
    CloseHandle(hMap);
    if (hReady) CloseHandle(hReady);
    if (hData) CloseHandle(hData);
    return;
  }

  parentPort?.postMessage({ type: "ready", alreadyExists });

  let warframeRecheckAt = Date.now() + WARFRAME_RECHECK_MS;

  try {
    while (Atomics.load(stopFlag, 0) === 0) {
      const waitResult = WaitForSingleObject(hData, WAIT_TIMEOUT_MS) as number;

      let buf: Buffer | null = null;
      if (waitResult === WAIT_OBJECT_0) {
        // OutputDebugString() in the game thread blocks until BUFFER_READY -
        // nothing may run before this ack but the one copy out of the buffer.
        const bytes = koffi.decode(pBuf, uint8ArrayType) as Uint8Array;
        SetEvent(hReady);
        buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } else {
        // A ready signal lost mid-handshake (writer or rival reader killed) otherwise
        // costs every later game line the ten second timeout until this reader closes.
        SetEvent(hReady);
      }

      const now = Date.now();
      if (now > warframeRecheckAt) {
        warframeRecheckAt = now + WARFRAME_RECHECK_MS;
        _pidIsWarframe.clear(); // refresh cache; Warframe may have a new PID
        if (!isWarframeRunning()) break; // exit Phase 1, return to Phase 0
      }

      // On WAIT_TIMEOUT (258) just loop and re-check stopFlag / Warframe presence
      if (!buf) continue;
      const pid = buf.readUInt32LE(0);
      if (!isWarframePid(pid)) continue;

      let end = buf.indexOf(0, 4);
      if (end < 0) end = DBWIN_BUFFER_SIZE;
      if (end <= 4) continue;
      // utf8 to match the file poll - latin1 split multi-byte glyphs into mojibake.
      const msg = buf.toString("utf8", 4, end);

      if (lineGate.wants(msg, now)) {
        parentPort?.postMessage({ type: "line", pid, msg });
      }
    }
  } finally {
    // A writer already blocked in OutputDebugString waits out the Win32 ten second
    // timeout if BUFFER_READY is never signalled again.
    SetEvent(hReady);
    UnmapViewOfFile(pBuf);
    CloseHandle(hMap);
    CloseHandle(hReady);
    CloseHandle(hData);
    _pidIsWarframe.clear();
  }
}

function run(): void {
  // The game's logger blocks until this thread acks each line - jump the queue.
  if (!SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST)) {
    parentPort?.postMessage({ type: "error", message: "SetThreadPriority failed" });
  }

  while (Atomics.load(stopFlag, 0) === 0) {
    while (Atomics.load(stopFlag, 0) === 0) {
      if (isWarframeRunning()) break;
      // Atomics.wait wakes immediately ("not-equal") when the parent sets stopFlag != 0.
      Atomics.wait(stopFlag, 0, 0, WARFRAME_POLL_MS);
    }

    if (Atomics.load(stopFlag, 0) !== 0) break;

    runDbwinLoop();
  }

  parentPort?.postMessage({ type: "stopped" });
}

run();
