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
 *
 * CPU-temperature mitigation — two-phase design:
 *
 *   PHASE 0  "Waiting for Warframe" (DBWIN objects do NOT exist)
 *   ────────────────────────────────────────────────────────────
 *   The DBWIN protocol requires the READER to create the named shared-memory
 *   objects first.  If those objects do not exist, every OutputDebugString call
 *   from any process (Chrome, Discord, IDEs, GPU drivers …) is a silent no-op —
 *   the writer opens the named objects, finds nothing, and returns immediately.
 *
 *   While we are in Phase 0 the worker simply sleeps (Atomics.wait) and
 *   periodically calls isWarframeRunning() to scan the process list.  CPU cost:
 *   near zero.
 *
 *   PHASE 1  "Warframe running" (DBWIN objects exist)
 *   ──────────────────────────────────────────────────
 *   Once Warframe.x64.exe is detected we create the three DBWIN objects and
 *   enter the message loop.  Non-Warframe PIDs are filtered cheaply:
 *     - koffi.decode(pBuf, "uint32")  — reads the 4-byte PID only
 *     - isWarframePid()               — OpenProcess + QueryFullProcessImageNameW,
 *                                       result cached per PID
 *     - SetEvent(hReady)              — release buffer without touching the message
 *
 *   Every WARFRAME_RECHECK_MS we call isWarframeRunning() again; when Warframe
 *   is gone we tear down the DBWIN objects and return to Phase 0.  Other
 *   processes' OutputDebugString calls immediately become no-ops again.
 */

import { workerData, parentPort } from "worker_threads";
import koffi from "koffi";

// ---------------------------------------------------------------------------
// Win32 API declarations
// ---------------------------------------------------------------------------
const kernel32 = koffi.load("kernel32.dll");
const psapi = koffi.load("psapi.dll");

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

// OpenProcess — used by isWarframePid() to query process image names
const OpenProcess = kernel32.func("OpenProcess", "void *", [
  "uint32", // dwDesiredAccess — PROCESS_QUERY_LIMITED_INFORMATION
  "bool",   // bInheritHandle  — FALSE
  "uint32", // dwProcessId
]);

// QueryFullProcessImageNameW — retrieves the full exe path for an open handle.
// lpExeName: caller-allocated WCHAR buffer.  lpdwSize: in=capacity, out=char count.
const QueryFullProcessImageNameW = kernel32.func(
  "QueryFullProcessImageNameW", "bool", [
  "void *", // hProcess
  "uint32", // dwFlags — 0 = Win32 path format
  "void *", // lpExeName  (PWSTR output buffer, raw pointer)
  "void *", // lpdwSize   (PDWORD in/out,        raw pointer)
]);

// EnumProcesses — fills a DWORD array with the PID of every running process.
// lpcbNeeded is set on return to the number of bytes written.
const EnumProcesses = psapi.func("EnumProcesses", "bool", [
  "void *", // lpidProcess — output: DWORD array of PIDs
  "uint32", // cb          — size of array in bytes
  "void *", // lpcbNeeded  — output: bytes written
]);

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
// PROCESS_QUERY_LIMITED_INFORMATION — minimum right for QueryFullProcessImageNameW
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// MAX_PATH in wide characters (WCHAR)
const MAX_PATH = 260;
// Phase 0: sleep this long between Warframe presence checks
const WARFRAME_POLL_MS = 2000;
// Phase 1: re-confirm Warframe is still running this often (milliseconds)
const WARFRAME_RECHECK_MS = 5000;
// Relic picker lines (LoadingCompleteEnd / PopulateInventoryGrid) fire at UI frame
// rate while the fissure screen is open.  Match the eeLogMonitor cooldown window so
// only one delivery per trigger cycle reaches the main thread.
const RELIC_PICKER_DBWIN_SUPPRESS_MS = 7500;
let _relicPickerSuppressUntil = 0;

// Pre-allocated koffi array type — avoid recreating it every tick
const uint8ArrayType = koffi.array("uint8", DBWIN_BUFFER_SIZE);

// Only forward lines that can possibly match a pattern in eeLogMonitor.
// Everything else is discarded here in the Worker — no IPC overhead.
// Lowercase to allow a single case-insensitive check without regex cost.
const FILTER_SUBSTRINGS_LOWER = [
  "loadingcompleteend",        // relic selection screen ready (primary trigger)
  "populateinventorygrid",     // relic selection screen ready (fallback trigger)
  "initmapping",               // relic picker close (returns to gameplay)
  "dialog::sendresult",        // relic/riven dialog closing
  "pause countdown done",      // mission reward trigger
  "got rewards",               // mission reward trigger
  "omegarerollselection.swf",  // riven rolling screen opened
  "diorama setup",             // riven diorama ready (OmegaRerollSelection.lua)
  "npcmanager::clearagents",   // riven session close
  "recycled effects",          // riven session close (alt signal)
  "dialog::createokcancel",    // riven cycle confirm / choice confirm
  "themeddetailedpurchasedialog", // chat riven HudVis + PopulateInfo detection
  "tradingpost.lua",           // trade partner detection
  "you are offering",          // trade dialog buffering start
  "the trade was successful",  // trade dialog success
] as const;

// ---------------------------------------------------------------------------
// isWarframePid — check (and cache) whether a PID belongs to Warframe.x64.exe
// ---------------------------------------------------------------------------
// Caches pid → boolean so that QueryFullProcessImageNameW is called once per
// newly-seen PID, not once per DBWIN message.  Caller is responsible for
// clearing the cache when re-entering Phase 1 after a Warframe restart.

const _pidIsWarframe = new Map<number, boolean>();

// Pre-allocated output buffers (reused every call — no per-call heap alloc)
const _exeNameBuf    = Buffer.alloc(MAX_PATH * 2); // WCHAR[MAX_PATH] = UTF-16LE path
const _exeNameSizeBuf = Buffer.alloc(4);            // DWORD in/out

function isWarframePid(pid: number): boolean {
  const cached = _pidIsWarframe.get(pid);
  if (cached !== undefined) return cached;

  const hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!hProc) {
    // Process may have exited; treat as not Warframe and don't cache —
    // if the PID reappears it may be Warframe next time.
    return false;
  }

  // Reset size to buffer capacity before the call (it is an in/out parameter)
  _exeNameSizeBuf.writeUInt32LE(MAX_PATH, 0);

  const ok = QueryFullProcessImageNameW(hProc, 0, _exeNameBuf, _exeNameSizeBuf) as boolean;
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

// ---------------------------------------------------------------------------
// isWarframeRunning — scan the process list for Warframe.x64.exe
// ---------------------------------------------------------------------------
// Uses EnumProcesses (psapi) + isWarframePid (kernel32).  The whole scan is
// cheap: for most PIDs isWarframePid is a single Map.get() after caching.

// Pre-allocated buffer for up to 1024 PIDs (4096 bytes ÷ 4 bytes per DWORD)
const _pidsBuf      = Buffer.alloc(4096);
const _pidsUsedBuf  = Buffer.alloc(4); // DWORD: bytes returned by EnumProcesses

function isWarframeRunning(): boolean {
  _pidsUsedBuf.fill(0);
  const ok = EnumProcesses(_pidsBuf, _pidsBuf.length, _pidsUsedBuf) as boolean;
  if (!ok) return false;

  const byteCount = _pidsUsedBuf.readUInt32LE(0);
  const count = byteCount >>> 2; // each PID is 4 bytes

  for (let i = 0; i < count; i++) {
    const pid = _pidsBuf.readUInt32LE(i * 4);
    if (pid === 0) continue; // System Idle Process — skip
    if (isWarframePid(pid)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const stopFlag = new Int32Array((workerData as { stopBuffer: SharedArrayBuffer }).stopBuffer);

function runDbwinLoop(): void {
  // Create DBWIN_BUFFER (pagefile-backed, writable so the sender can use it)
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
  // DBWIN_DATA_READY:  auto-reset (false), initially unsignaled (false)
  const hData  = CreateEventW(null, false, false, "DBWIN_DATA_READY");

  if (!hReady || !hData) {
    parentPort?.postMessage({
      type: "error",
      message: `CreateEventW failed (GLE=${GetLastError()})`,
    });
    UnmapViewOfFile(pBuf);
    CloseHandle(hMap);
    if (hReady) CloseHandle(hReady);
    if (hData)  CloseHandle(hData);
    return;
  }

  parentPort?.postMessage({ type: "ready", alreadyExists });

  let warframeRecheckAt = Date.now() + WARFRAME_RECHECK_MS;

  try {
    while (Atomics.load(stopFlag, 0) === 0) {
      const waitResult = WaitForSingleObject(hData, WAIT_TIMEOUT_MS) as number;

      const now = Date.now();

      // ── Periodic Warframe exit check ────────────────────────────────────
      // Check both on timeout AND on message receipt (so that if noisy
      // non-Warframe processes keep the loop busy, we still detect exit).
      if (now > warframeRecheckAt) {
        warframeRecheckAt = now + WARFRAME_RECHECK_MS;
        _pidIsWarframe.clear(); // refresh cache; Warframe may have a new PID
        if (!isWarframeRunning()) break; // exit Phase 1, return to Phase 0
      }

      if (waitResult === WAIT_OBJECT_0) {
        // ── Phase 1 inner: read 4-byte PID cheaply ────────────────────────
        const pid = koffi.decode(pBuf, "uint32") as number;

        if (!isWarframePid(pid)) {
          // Not Warframe — release buffer immediately and skip message body.
          // DBWIN_BUFFER_READY MUST be signalled or the writing process blocks.
          SetEvent(hReady);
          continue;
        }

        // ── Warframe PID: full 4096-byte copy ────────────────────────────
        const bytes = koffi.decode(pBuf, uint8ArrayType) as number[];

        // *** CRITICAL: Re-signal BUFFER_READY immediately after the copy. ***
        // OutputDebugString() in Warframe's thread waits on BUFFER_READY with a
        // short timeout (~10 ms). Signalling here returns the buffer to Warframe
        // in microseconds; all subsequent JS work runs concurrently.
        SetEvent(hReady);

        // --- Process the now-local copy (Warframe is unblocked above) ---
        const buf = Buffer.from(bytes);

        // Find null terminator for the message string (starts at offset 4)
        let end = 4;
        while (end < buf.length && buf[end] !== 0) end++;
        const msg = buf.slice(4, end).toString("latin1");

        // Pre-filter: only forward lines that match one of our trigger substrings.
        // The main thread's handleLine() still does the authoritative regex check.
        if (msg) {
          const msgLower = msg.toLowerCase();
          if (FILTER_SUBSTRINGS_LOWER.some((s) => msgLower.includes(s))) {
            // Relic picker lines fire at screen-refresh rate while the fissure screen
            // is open.  Suppress within the cooldown window to stop flooding the main
            // thread event loop (which would starve async OCR and cause UI lag).
            const isRelicLine =
              msgLower.includes("loadingcompleteend") ||
              msgLower.includes("populateinventorygrid");
            if (isRelicLine) {
              if (now < _relicPickerSuppressUntil) continue;
              _relicPickerSuppressUntil = now + RELIC_PICKER_DBWIN_SUPPRESS_MS;
            }
            parentPort?.postMessage({ type: "line", pid, msg });
          }
        }
      }
      // On WAIT_TIMEOUT (258) just loop and re-check stopFlag / Warframe presence
    }
  } finally {
    UnmapViewOfFile(pBuf);
    CloseHandle(hMap);
    CloseHandle(hReady);
    CloseHandle(hData);
    // Flush the PID cache on every Phase 1 exit so that a restarted Warframe
    // process (new PID) is not denied based on a stale cache entry.
    _pidIsWarframe.clear();
  }
}

function run(): void {
  // ── Outer loop: Phase 0 → Phase 1 → Phase 0 → … ──────────────────────────
  //
  // Phase 0: DBWIN objects do NOT exist → all other processes' OutputDebugString
  //          calls are no-ops → worker sleeps; CPU cost ≈ 0.
  // Phase 1: Warframe detected → DBWIN active → message loop (runDbwinLoop).

  while (Atomics.load(stopFlag, 0) === 0) {
    // ── Phase 0: Sleep until Warframe.x64.exe appears ──────────────────────
    while (Atomics.load(stopFlag, 0) === 0) {
      if (isWarframeRunning()) break;
      // Atomics.wait sleeps up to WARFRAME_POLL_MS but wakes immediately
      // (returning "not-equal") if the parent sets stopFlag ≠ 0.
      Atomics.wait(stopFlag, 0, 0, WARFRAME_POLL_MS);
    }

    if (Atomics.load(stopFlag, 0) !== 0) break;

    // ── Phase 1: Warframe is running — activate DBWIN ──────────────────────
    // runDbwinLoop() returns when Warframe exits or stopFlag is set.
    runDbwinLoop();
  }

  parentPort?.postMessage({ type: "stopped" });
}

run();
