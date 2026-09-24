import {
  bestAuthz,
  createAuthzScanDiagnostics,
  scanBufferForAuthz,
  spanAround,
  type MemoryScanVisitor,
  type ProcessMemoryReader,
  type ScannableRegion,
} from "./gameMemoryAuthz";
import { withScope } from "./logger";
import { enumProcessIds, exePathOfPid, isWarframeExePath } from "./win32Process";

const log = withScope("gameMemoryWin");

// Keep the fallback optional on unsupported systems.
let _koffi: typeof import("koffi") | null = null;
function koffi(): typeof import("koffi") {
  if (!_koffi) _koffi = require("koffi") as typeof import("koffi");
  return _koffi;
}

let _api: Win32 | null = null;
let _apiFailed = false;

// koffi's KoffiFunction type is not exported; a callable with `.async` is all
// we need. `.async` appends a Node-style callback and runs off the main thread.
type NativeFn = ((...args: unknown[]) => unknown) & {
  async: (...args: unknown[]) => void;
};

interface Win32 {
  OpenProcess: NativeFn;
  CloseHandle: NativeFn;
  GetLastError: NativeFn;
  VirtualQueryEx: NativeFn;
  ReadProcessMemory: NativeFn;
  QueryWorkingSetEx: NativeFn;
}

function loadApi(): Win32 | null {
  if (_api) return _api;
  if (_apiFailed) return null;
  try {
    const k = koffi();
    const kernel32 = k.load("kernel32.dll");
    _api = {
      // Win32 BOOL is a 4-byte int; koffi's "bool" is 1 byte and leaves garbage
      // in the upper bytes, so always declare BOOL params/returns as int32.
      OpenProcess: kernel32.func("OpenProcess", "void *", [
        "uint32",
        "int32",
        "uint32",
      ]) as NativeFn,
      CloseHandle: kernel32.func("CloseHandle", "int32", ["void *"]) as NativeFn,
      GetLastError: kernel32.func("GetLastError", "uint32", []) as NativeFn,
      // lpAddress/lpBaseAddress declared as uint64 so we can pass raw BigInt
      // addresses (same 8-byte ABI as a pointer) instead of pointer objects.
      VirtualQueryEx: kernel32.func("VirtualQueryEx", "size_t", [
        "void *",
        "uint64",
        "void *",
        "size_t",
      ]) as NativeFn,
      ReadProcessMemory: kernel32.func("ReadProcessMemory", "int32", [
        "void *",
        "uint64",
        "void *",
        "size_t",
        "void *",
      ]) as NativeFn,
      QueryWorkingSetEx: kernel32.func("K32QueryWorkingSetEx", "int32", [
        "void *",
        "void *",
        "uint32",
      ]) as NativeFn,
    };
    return _api;
  } catch (err) {
    _apiFailed = true;
    log.warn("koffi load failed - native memory scan unavailable:", errMsg(err));
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const PAGE_NOACCESS = 0x01;
const PAGE_READWRITE = 0x04;
const PAGE_EXECUTE = 0x10;
const PAGE_GUARD = 0x100;
// x64 MEMORY_BASIC_INFORMATION is 48 bytes; fields we read: BaseAddress@0,
// RegionSize@24, State@32, Protect@36, Type@40 (all little-endian).
const MBI_SIZE = 48;
const USER_ADDRESS_CEILING = 0x7fffffff0000n;
const CHUNK = 4 * 1024 * 1024;
// Keeps an auth string or an inventory anchor whole across a chunk boundary.
const OVERLAP = 256;
const PAGE_SIZE = 4096;
// x64 PSAPI_WORKING_SET_EX_INFORMATION: VirtualAddress@0, attributes@8 with bit 0 = Valid.
const WS_ENTRY_SIZE = 16;

interface AuthzResult {
  authz: string | null;
  reason: string;
}

function findWarframePids(): number[] {
  return enumProcessIds().filter((pid) => isWarframeExePath(exePathOfPid(pid)));
}

function isReadableRegion(state: number, protect: number): boolean {
  if (state !== MEM_COMMIT) return false;
  if (protect & PAGE_GUARD) return false;
  if (protect === PAGE_NOACCESS || protect === PAGE_EXECUTE) return false;
  return true;
}

/** Heap memory only: committed, private and plain read-write, as parsed JSON lives. */
export function isPrivateReadWriteRegion(state: number, protect: number, type: number): boolean {
  return isReadableRegion(state, protect) && type === MEM_PRIVATE && protect === PAGE_READWRITE;
}

interface MemoryReadResult {
  bytesRead: number;
  failed: boolean;
}

function readMemory(
  api: Win32,
  hProc: unknown,
  addr: bigint,
  out: Buffer,
  len: number,
  bytesReadBuf: Buffer,
): Promise<MemoryReadResult> {
  return new Promise((resolve) => {
    bytesReadBuf.fill(0);
    api.ReadProcessMemory.async(
      hProc,
      addr,
      out,
      len,
      bytesReadBuf,
      (err: Error | null, ok: number) => {
        const reported = Number(bytesReadBuf.readBigUInt64LE(0));
        const bytesRead = Number.isSafeInteger(reported) ? Math.min(reported, len, out.length) : 0;
        resolve({ bytesRead, failed: Boolean(err) || ok === 0 });
      },
    );
  });
}

interface WinMemoryScan {
  /** "mem-open-noapi", "process-not-found" or "mem-open-<GetLastError>"; null after a scan. */
  failure: string | null;
  pids: number;
  openedProcesses: number;
  regions: number;
  bytes: number;
  /** Committed bytes left unread because the game did not have them in RAM. */
  skippedBytes: number;
  failedReads: number;
  partialReads: number;
}

type RegionFilter = (state: number, protect: number, type: number) => boolean;

interface RegionInfo {
  base: bigint;
  size: bigint;
  state: number;
  protect: number;
  type: number;
}

/** VirtualQueryEx's regions upward from `from` until `to`; the first starts at from's page. */
function* queryRegions(
  api: Win32,
  hProc: unknown,
  from: bigint,
  to: bigint,
): Generator<RegionInfo> {
  const mbi = Buffer.alloc(MBI_SIZE);
  let addr = from;
  while (addr < to) {
    const written = api.VirtualQueryEx(hProc, addr, mbi, MBI_SIZE) as number;
    if (written === 0) return;
    const base = mbi.readBigUInt64LE(0);
    const size = mbi.readBigUInt64LE(24);
    const next = base + size;
    if (size === 0n || next <= addr) return;
    yield {
      base,
      size,
      state: mbi.readUInt32LE(32),
      protect: mbi.readUInt32LE(36),
      type: mbi.readUInt32LE(40),
    };
    addr = next;
  }
}

function* includedRegions(
  api: Win32,
  hProc: unknown,
  include: RegionFilter,
  from: bigint,
  to: bigint,
): Generator<ScannableRegion> {
  for (const region of queryRegions(api, hProc, from, to)) {
    if (include(region.state, region.protect, region.type)) {
      yield { start: Number(region.base), end: Number(region.base + region.size) };
    }
  }
}

/** Runs of [start, start + len) in the game's working set as [offset, length]; null when unknown. */
function residentRuns(
  api: Win32,
  hProc: unknown,
  start: bigint,
  len: number,
  ws: Buffer,
): Array<[number, number]> | null {
  const page = BigInt(PAGE_SIZE);
  const first = (start / page) * page;
  const pages = Number((start + BigInt(len) - first + page - 1n) / page);
  for (let i = 0; i < pages; i += 1) {
    ws.writeBigUInt64LE(first + BigInt(i) * page, i * WS_ENTRY_SIZE);
    ws.writeBigUInt64LE(0n, i * WS_ENTRY_SIZE + 8);
  }
  if (!api.QueryWorkingSetEx(hProc, ws, pages * WS_ENTRY_SIZE)) return null;
  const lead = Number(start - first);
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let i = 0; i <= pages; i += 1) {
    const valid = i < pages && (ws.readUInt32LE(i * WS_ENTRY_SIZE + 8) & 1) === 1;
    if (valid && runStart < 0) runStart = i;
    if (!valid && runStart >= 0) {
      const from = Math.max(0, runStart * PAGE_SIZE - lead);
      const to = Math.min(len, i * PAGE_SIZE - lead);
      if (to > from) runs.push([from, to - from]);
      runStart = -1;
    }
  }
  return runs;
}

/** Walks every Warframe.x64 process's memory read-only; the filter picks the regions.
 *  residentOnly skips pages outside the game's working set: reading them pages them
 *  back into the game (2.2 GB read against 973 MB game RAM lagged it, 2026-09-24). */
export async function scanGameMemoryWin(
  visitor: MemoryScanVisitor,
  include: RegionFilter,
  apiOverride?: Win32,
  residentOnly = false,
): Promise<WinMemoryScan> {
  const result: WinMemoryScan = {
    failure: null,
    pids: 0,
    openedProcesses: 0,
    regions: 0,
    bytes: 0,
    skippedBytes: 0,
    failedReads: 0,
    partialReads: 0,
  };
  const api = apiOverride ?? loadApi();
  if (!api) return { ...result, failure: "mem-open-noapi" };

  const pids = findWarframePids();
  result.pids = pids.length;
  if (pids.length === 0) return { ...result, failure: "process-not-found" };

  const chunk = Buffer.allocUnsafe(CHUNK);
  const bytesReadBuf = Buffer.alloc(8);
  const readerBytesBuf = Buffer.alloc(8);
  const ws = Buffer.alloc((CHUNK / PAGE_SIZE + 1) * WS_ENTRY_SIZE);
  let iterations = 0;
  let firstOpenError: number | null = null;

  for (const pid of pids) {
    const hProc = api.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) as unknown;
    if (!hProc) {
      firstOpenError ??= api.GetLastError() as number;
      continue;
    }
    result.openedProcesses += 1;

    const reader: ProcessMemoryReader = {
      async read(address, out) {
        const read = await readMemory(api, hProc, BigInt(address), out, out.length, readerBytesBuf);
        return read.bytesRead;
      },
      readableSpan(address, limit) {
        const from = BigInt(Math.max(0, address - limit));
        const to = BigInt(address + limit);
        return spanAround(includedRegions(api, hProc, include, from, to), address, limit);
      },
    };

    const visit = async (
      at: bigint,
      len: number,
      region: { start: number; end: number },
    ): Promise<void> => {
      const read = await readMemory(api, hProc, at, chunk, len, bytesReadBuf);
      if (read.failed) {
        if (read.bytesRead > 0) result.partialReads += 1;
        else result.failedReads += 1;
      }
      if (read.bytesRead > 0) {
        visitor.chunk(chunk.subarray(0, read.bytesRead), Number(at), region);
        result.bytes += read.bytesRead;
      }
    };

    try {
      for (const info of queryRegions(api, hProc, 0n, USER_ADDRESS_CEILING)) {
        const { base, size: regionSize } = info;
        if (include(info.state, info.protect, info.type)) {
          result.regions += 1;
          const region = { start: Number(base), end: Number(base + regionSize) };
          let off = 0n;
          while (off < regionSize) {
            const remaining = regionSize - off;
            const len = remaining < BigInt(CHUNK) ? Number(remaining) : CHUNK;
            const runs = residentOnly ? residentRuns(api, hProc, base + off, len, ws) : null;
            if (runs === null) {
              await visit(base + off, len, region);
            } else {
              let resident = 0;
              for (const [runOffset, runLength] of runs) {
                resident += runLength;
                await visit(base + off + BigInt(runOffset), runLength, region);
              }
              result.skippedBytes += len - resident;
            }
            if (len <= OVERLAP) break;
            off += BigInt(len - OVERLAP);
            if (++iterations % 16 === 0) await new Promise((r) => setImmediate(r));
          }
        }
      }
      await visitor.finish?.(reader);
    } finally {
      api.CloseHandle(hProc);
    }
  }

  if (result.openedProcesses === 0)
    return { ...result, failure: `mem-open-${firstOpenError ?? 0}` };
  return result;
}

export async function readGameAuthzWin(apiOverride?: Win32): Promise<AuthzResult> {
  const counts = new Map<string, number>();
  const diagnostics = createAuthzScanDiagnostics();
  let markerHits = 0;
  const scan = await scanGameMemoryWin(
    {
      chunk: (view) => {
        markerHits += scanBufferForAuthz(view, counts, diagnostics);
      },
    },
    isReadableRegion,
    apiOverride,
  );
  if (scan.failure) return { authz: null, reason: scan.failure };

  if (counts.size === 0) {
    const gib = (scan.bytes / (1024 * 1024 * 1024)).toFixed(1);
    log.warn(
      `No valid auth matches: markers=${markerHits}, ` +
        `processes=${scan.openedProcesses}/${scan.pids}, ` +
        `scanned=${gib} GiB, regions=${scan.regions}, failedReads=${scan.failedReads}, ` +
        `partialReads=${scan.partialReads}, rejects=${JSON.stringify(diagnostics)}`,
    );
    return { authz: null, reason: "crumbs-not-found" };
  }
  const { authz, hits, ambiguous } = bestAuthz(counts);
  if (ambiguous) {
    log.warn(`Multiple auth matches share the highest frequency (${hits}) - refusing all`);
    return { authz: null, reason: "crumbs-ambiguous" };
  }
  if (counts.size > 1) {
    log.warn(`Multiple distinct auth matches (${counts.size}) - using the most frequent`);
  }
  return { authz, reason: `ok-${hits}x` };
}
