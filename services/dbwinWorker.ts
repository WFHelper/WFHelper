/**
 * Worker thread: listens on Windows OutputDebugString shared memory (DBWIN protocol)
 * and posts matching log lines to the parent thread with zero disk-flush latency.
 *
 * The DBWIN protocol (used by Win32 OutputDebugString):
 *   DBWIN_BUFFER      — pagefile-backed shared memory, 4096 bytes:
 *                         [0..3]  DWORD   pid  (process id of writer)
 *                         [4..4095] char  msg  (null-terminated debug string)
 *   DBWIN_BUFFER_READY — auto-reset event, initially signaled:
 *                         "reader is ready to accept the next message"
 *   DBWIN_DATA_READY   — auto-reset event, initially unsignaled:
 *                         "new data has been written to DBWIN_BUFFER"
 *
 * Writer (Warframe / OutputDebugString internal):
 *   1. Opens pre-existing objects (they must already exist, or it no-ops)
 *   2. Waits briefly for DBWIN_BUFFER_READY (up to 10 ms)
 *   3. Writes own PID + message into DBWIN_BUFFER
 *   4. Signals DBWIN_DATA_READY
 *   5. Waits briefly for DBWIN_BUFFER_READY to be re-set (acknowledgement)
 *
 * Reader (this worker):
 *   1. Creates the three DBWIN objects so the writer can open them
 *   2. Signals DBWIN_BUFFER_READY immediately ("ready for first write")
 *   3. Blocks on WaitForSingleObject(DBWIN_DATA_READY, 500 ms)
 *   4. On WAIT_OBJECT_0: reads PID + message, posts to parent, re-signals DBWIN_BUFFER_READY
 *   5. On WAIT_TIMEOUT: re-checks the stop flag, loops
 *
 * Shutdown:
 *   Parent sets stopBuffer[0] = 1 via Atomics.  After at most WAIT_TIMEOUT_MS the
 *   worker exits its loop, closes all handles, and posts { type: "stopped" }.
 */

import { workerData, parentPort } from "worker_threads";
import koffi from "koffi";

// ---------------------------------------------------------------------------
// Win32 API declarations
// ---------------------------------------------------------------------------
const kernel32 = koffi.load("kernel32.dll");

const CreateFileMappingW = kernel32.func("CreateFileMappingW", "void *", [
  "void *", // hFile            — INVALID_HANDLE_VALUE (-1n) for pagefile-backed
  "void *", // lpAttributes     — NULL
  "uint32", // flProtect        — PAGE_READWRITE
  "uint32", // dwMaximumSizeHigh
  "uint32", // dwMaximumSizeLow
  "str16",  // lpName
]);

const MapViewOfFile = kernel32.func("MapViewOfFile", "void *", [
  "void *", // hFileMappingObject
  "uint32", // dwDesiredAccess
  "uint32", // dwFileOffsetHigh
  "uint32", // dwFileOffsetLow
  "size_t", // dwNumberOfBytesToMap — 0 = map the whole thing
]);

const UnmapViewOfFile = kernel32.func("UnmapViewOfFile", "bool", ["void *"]);

const CreateEventW = kernel32.func("CreateEventW", "void *", [
  "void *", // lpEventAttributes — NULL
  "bool",   // bManualReset
  "bool",   // bInitialState
  "str16",  // lpName
]);

const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", [
  "void *", // hHandle
  "uint32", // dwMilliseconds
]);

const SetEvent = kernel32.func("SetEvent", "bool", ["void *"]);
const CloseHandle = kernel32.func("CloseHandle", "bool", ["void *"]);
const GetLastError = kernel32.func("GetLastError", "uint32", []);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PAGE_READWRITE = 0x04;
const FILE_MAP_READ = 0x0004;
const WAIT_OBJECT_0 = 0;
const ERROR_ALREADY_EXISTS = 183;
const DBWIN_BUFFER_SIZE = 4096;
// INVALID_HANDLE_VALUE = (HANDLE)(-1) = 0xFFFF_FFFF_FFFF_FFFF on 64-bit
const INVALID_HANDLE_VALUE = -1n;
// How long to block on WaitForSingleObject before re-checking the stop flag
const WAIT_TIMEOUT_MS = 500;

// Pre-allocated koffi array type — avoid recreating it every tick
const uint8ArrayType = koffi.array("uint8", DBWIN_BUFFER_SIZE);

// Only forward lines that can possibly match a pattern in eeLogMonitor.
// Everything else is discarded here in the Worker — no IPC overhead.
// Lowercase to allow a single case-insensitive check without regex cost.
const FILTER_SUBSTRINGS_LOWER = [
  "loadingcompleteend",   // relic selection screen ready (primary trigger)
  "populateinventorygrid", // relic selection screen ready (fallback trigger)
  "dialog::sendresult",   // relic selection dialog closing
  "pause countdown done", // mission reward trigger
  "got rewards",          // mission reward trigger
] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const stopFlag = new Int32Array((workerData as { stopBuffer: SharedArrayBuffer }).stopBuffer);

function run(): void {
  // --- Create DBWIN_BUFFER (pagefile-backed, writable so the sender can use it) ---
  const hMap = CreateFileMappingW(
    INVALID_HANDLE_VALUE,
    null,
    PAGE_READWRITE,
    0,
    DBWIN_BUFFER_SIZE,
    "DBWIN_BUFFER",
  );

  if (!hMap) {
    parentPort?.postMessage({
      type: "error",
      message: `CreateFileMappingW failed (GLE=${GetLastError()})`,
    });
    return;
  }

  const alreadyExists = GetLastError() === ERROR_ALREADY_EXISTS;

  // Map with read access only — the writer fills the buffer, we just read it
  const pBuf = MapViewOfFile(hMap, FILE_MAP_READ, 0, 0, 0);
  if (!pBuf) {
    parentPort?.postMessage({
      type: "error",
      message: `MapViewOfFile failed (GLE=${GetLastError()})`,
    });
    CloseHandle(hMap);
    return;
  }

  // DBWIN_BUFFER_READY: auto-reset (false), initially signaled (true) — "ready to receive"
  const hReady = CreateEventW(null, false, true, "DBWIN_BUFFER_READY");
  // DBWIN_DATA_READY: auto-reset (false), initially unsignaled (false)
  const hData = CreateEventW(null, false, false, "DBWIN_DATA_READY");

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

  try {
    while (Atomics.load(stopFlag, 0) === 0) {
      const waitResult = WaitForSingleObject(hData, WAIT_TIMEOUT_MS) as number;

      if (waitResult === WAIT_OBJECT_0) {
        // Copy the 4096-byte buffer out of shared memory into JS heap.
        const bytes = koffi.decode(pBuf, uint8ArrayType) as number[];

        // *** CRITICAL: Re-signal BUFFER_READY immediately after the copy. ***
        // OutputDebugString() in Warframe's thread waits on BUFFER_READY with a
        // short timeout (~10 ms). If we delay this call until after all the JS
        // processing below, every OutputDebugString call stalls for that duration
        // and causes visible frame drops in-game.  By signalling here we give the
        // buffer back to Warframe in microseconds; all subsequent JS work happens
        // concurrently while Warframe's thread is already running.
        SetEvent(hReady);

        // --- Process the now-local copy (Warframe is unblocked above) ---
        const buf = Buffer.from(bytes);
        const pid = buf.readUInt32LE(0);

        // Find null terminator for the message string (starts at offset 4)
        let end = 4;
        while (end < buf.length && buf[end] !== 0) end++;
        const msg = buf.slice(4, end).toString("latin1");

        // Pre-filter: only forward lines that match one of our trigger substrings.
        // The main thread's handleLine() still does the authoritative regex check.
        if (msg) {
          const msgLower = msg.toLowerCase();
          if (FILTER_SUBSTRINGS_LOWER.some((s) => msgLower.includes(s))) {
            parentPort?.postMessage({ type: "line", pid, msg });
          }
        }
      }
      // On WAIT_TIMEOUT (258) just loop and re-check stopFlag
    }
  } finally {
    UnmapViewOfFile(pBuf);
    CloseHandle(hMap);
    CloseHandle(hReady);
    CloseHandle(hData);
  }

  parentPort?.postMessage({ type: "stopped" });
}

run();
