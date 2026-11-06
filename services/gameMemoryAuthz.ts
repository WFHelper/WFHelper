// Proton often keeps fewer than Sainan's three copies, so accept a unique leading match.
import fs from "node:fs";

import { withScope } from "./logger";

const log = withScope("gameMemory");

const ACCOUNT_ID_MARKERS = [Buffer.from("?accountId="), Buffer.from("&accountId=")] as const;
// Login response layout as FrameForge's scanner matches it. Not yet confirmed
// against this game's memory.
const LOGIN_ID_MARKER = Buffer.from('"id":"');
const LOGIN_NONCE_MARKER = Buffer.from('"Nonce":');
const LOGIN_NONCE_WINDOW = 2048;
const CHUNK = 16 * 1024 * 1024;
// Must exceed the longest match: a login id, the 2048-byte window to its Nonce,
// and the nonce itself.
export const SCAN_OVERLAP = 4096;
const ACCOUNT_ID_LEN = 24; // DE account ids are 24-hex Mongo ObjectIds
const NONCE_SEP = "&nonce=";
const MIN_NONCE_DIGITS = 5;
const MAX_NONCE_DIGITS = 24;
// start-end perms offset dev inode [pathname]
const MAPS_LINE = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ +\S+(?:\s+(.*))?$/;
const MAX_REGION_BYTES = 4 * 1024 * 1024 * 1024; // reserve guard, never a real heap

interface AuthzScanDiagnostics {
  truncated: number;
  invalidAccountId: number;
  missingNonce: number;
  emptyNonce: number;
  nonceTooLong: number;
  shortNonce: number;
}

type AuthzParseResult =
  | { authz: string; rejection: null }
  | { authz: null; rejection: keyof AuthzScanDiagnostics };

export function createAuthzScanDiagnostics(): AuthzScanDiagnostics {
  return {
    truncated: 0,
    invalidAccountId: 0,
    missingNonce: 0,
    emptyNonce: 0,
    nonceTooLong: 0,
    shortNonce: 0,
  };
}

function parseAuthzCandidate(view: Buffer, at: number, markerLength: number): AuthzParseResult {
  const idStart = at + markerLength;
  const idEnd = idStart + ACCOUNT_ID_LEN;
  if (idEnd > view.length) return { authz: null, rejection: "truncated" };
  const accountId = view.toString("latin1", idStart, idEnd);
  if (!/^[0-9a-f]{24}$/i.test(accountId)) {
    return { authz: null, rejection: "invalidAccountId" };
  }
  if (idEnd + NONCE_SEP.length > view.length) {
    return { authz: null, rejection: "truncated" };
  }
  if (view.toString("latin1", idEnd, idEnd + NONCE_SEP.length) !== NONCE_SEP) {
    return { authz: null, rejection: "missingNonce" };
  }
  let p = idEnd + NONCE_SEP.length;
  let nonce = "";
  while (p < view.length && nonce.length < MAX_NONCE_DIGITS) {
    const c = view[p];
    if (c < 0x30 || c > 0x39) break; // not a digit
    nonce += String.fromCharCode(c);
    p++;
  }
  if (nonce.length === 0) {
    return { authz: null, rejection: p === view.length ? "truncated" : "emptyNonce" };
  }
  if (p < view.length && view[p] >= 0x30 && view[p] <= 0x39) {
    return { authz: null, rejection: "nonceTooLong" };
  }
  if (nonce.length < MIN_NONCE_DIGITS) {
    return { authz: null, rejection: "shortNonce" };
  }
  return { authz: `?accountId=${accountId.toLowerCase()}&nonce=${nonce}`, rejection: null };
}

function parseLoginJsonAt(view: Buffer, at: number): string | null {
  const idStart = at + LOGIN_ID_MARKER.length;
  const idEnd = idStart + ACCOUNT_ID_LEN;
  if (idEnd >= view.length || view[idEnd] !== 0x22) return null; // id must close its quote
  const accountId = view.toString("latin1", idStart, idEnd);
  if (!/^[0-9a-f]{24}$/i.test(accountId)) return null;

  const windowEnd = Math.min(idEnd + LOGIN_NONCE_WINDOW, view.length);
  const rel = view.subarray(idEnd, windowEnd).indexOf(LOGIN_NONCE_MARKER);
  if (rel === -1) return null;
  const nonceStart = idEnd + rel + LOGIN_NONCE_MARKER.length;
  let nonceEnd = nonceStart;
  while (nonceEnd < view.length && nonceEnd - nonceStart <= MAX_NONCE_DIGITS) {
    const c = view[nonceEnd];
    if (c < 0x30 || c > 0x39) break;
    nonceEnd++;
  }
  const digits = nonceEnd - nonceStart;
  if (digits < MIN_NONCE_DIGITS || digits > MAX_NONCE_DIGITS || nonceEnd === view.length) {
    return null;
  }
  const nonce = view.toString("latin1", nonceStart, nonceEnd);
  return `?accountId=${accountId.toLowerCase()}&nonce=${nonce}`;
}

/** Rejections are not counted in the diagnostics, because most `"id":"` hits belong to unrelated objects. */
function scanBufferForLoginJson(view: Buffer, counts: Map<string, number>): void {
  let idx = 0;
  while ((idx = view.indexOf(LOGIN_ID_MARKER, idx)) !== -1) {
    const authz = parseLoginJsonAt(view, idx);
    if (authz !== null) counts.set(authz, (counts.get(authz) ?? 0) + 1);
    idx += LOGIN_ID_MARKER.length;
  }
}

function tally(
  result: AuthzParseResult,
  diagnostics: AuthzScanDiagnostics | undefined,
): string | null {
  if (result.rejection && diagnostics) diagnostics[result.rejection] += 1;
  return result.authz;
}

/** Parse the auth string at a marker hit, or null when the offset is not one. */
export function parseAuthzAt(
  view: Buffer,
  at: number,
  diagnostics?: AuthzScanDiagnostics,
): string | null {
  const marker = ACCOUNT_ID_MARKERS.find((candidate) =>
    view.subarray(at, at + candidate.length).equals(candidate),
  );
  if (!marker) return null;
  return tally(parseAuthzCandidate(view, at, marker.length), diagnostics);
}

export function scanBufferForAuthz(
  view: Buffer,
  counts: Map<string, number>,
  diagnostics?: AuthzScanDiagnostics,
): number {
  let markerHits = 0;
  for (const marker of ACCOUNT_ID_MARKERS) {
    let idx = 0;
    while ((idx = view.indexOf(marker, idx)) !== -1) {
      markerHits += 1;
      // parseAuthzAt re-derives the marker; the loop already knows it, and this
      // runs once per hit across every readable page of a multi-GB process.
      const authz = tally(parseAuthzCandidate(view, idx, marker.length), diagnostics);
      if (authz !== null) counts.set(authz, (counts.get(authz) ?? 0) + 1);
      idx += marker.length;
    }
  }
  return markerHits;
}

// Pick a unique most-frequent match; equal leaders are not safe to use.
export function bestAuthz(counts: Map<string, number>): {
  authz: string | null;
  hits: number;
  ambiguous: boolean;
} {
  let authz: string | null = null;
  let hits = 0;
  let ambiguous = false;
  for (const [k, v] of counts) {
    if (v > hits) {
      authz = k;
      hits = v;
      ambiguous = false;
    } else if (v === hits && v > 0) {
      ambiguous = true;
    }
  }
  return { authz: ambiguous ? null : authz, hits, ambiguous };
}

export interface AuthzTally {
  url: Map<string, number>;
  loginJson: Map<string, number>;
}

export function createAuthzTally(): AuthzTally {
  return { url: new Map(), loginJson: new Map() };
}

export function scanBufferForAuthzTally(
  view: Buffer,
  tally: AuthzTally,
  diagnostics?: AuthzScanDiagnostics,
): number {
  scanBufferForLoginJson(view, tally.loginJson);
  return scanBufferForAuthz(view, tally.url, diagnostics);
}

// The URL form wins whenever it matched. Login JSON hits are noisier and could
// tie with a real candidate, so they only count when nothing else matched.
export function selectAuthzCounts(tally: AuthzTally): {
  counts: Map<string, number>;
  source: "url" | "login-json";
} {
  return tally.url.size > 0
    ? { counts: tally.url, source: "url" }
    : { counts: tally.loginJson, source: "login-json" };
}

export interface ScannableRegion {
  start: number;
  end: number;
}

export interface ProcessMemoryReader {
  read(address: number, out: Buffer): Promise<number>;
  readableSpan?(address: number, limit: number): ScannableRegion | null;
}

export function spanAround(
  ascending: Iterable<ScannableRegion>,
  address: number,
  limit: number,
): ScannableRegion | null {
  let run: ScannableRegion | null = null;
  for (const region of ascending) {
    if (run !== null && region.start === run.end) {
      run.end = region.end;
    } else {
      if (run !== null && run.end > address) break;
      if (region.start > address) return null;
      run = { start: region.start, end: region.end };
    }
    if (run.end >= address + limit) break;
  }
  if (run === null || address < run.start || address >= run.end) return null;
  return { start: Math.max(run.start, address - limit), end: Math.min(run.end, address + limit) };
}

/** One consumer of a game-memory walk. Chunks of a region overlap by OVERLAP bytes. */
export interface MemoryScanVisitor {
  chunk(view: Buffer, address: number, region: ScannableRegion): void;
  /** Runs once per scanned process before its handle closes. */
  finish?(reader: ProcessMemoryReader): Promise<void>;
  /** Linux only: rescan private file-backed mappings after an empty anonymous pass. */
  wantsWiderScan?(): boolean;
}

interface LinuxMemoryScan {
  /** "process-not-found" or "mem-open-<code>"; null once the scan ran. */
  failure: string | null;
  regions: number;
  bytes: number;
}

// The auth string is built at runtime, so it only ever lives in private writable
// memory. Reading /dev/ or special mappings faults the driver and stalls the game.
export function scannableRegionFromMapsLine(line: string, widen = false): ScannableRegion | null {
  const m = line.match(MAPS_LINE);
  if (!m) return null;
  const perms = m[3];
  if (perms[0] !== "r" || perms[1] !== "w" || perms[3] !== "p") return null;
  const path = (m[4] ?? "").trim();
  if (path.startsWith("/dev/")) return null;
  if (path.startsWith("[vvar") || path === "[vdso]" || path === "[vsyscall]") return null;
  if (!widen && path !== "") return null;
  const start = parseInt(m[1], 16);
  const end = parseInt(m[2], 16);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
  if (end - start > MAX_REGION_BYTES) return null;
  return { start, end };
}

function* scannableRegions(lines: string[], widen: boolean): Generator<ScannableRegion> {
  for (const line of lines) {
    const region = scannableRegionFromMapsLine(line, widen);
    if (region) yield region;
  }
}

// comm is capped at 15 chars, so Warframe.x64.exe reads "Warframe.x64.ex". Matching
// on "warframe" alone once picked a script whose comm was "warframe-unfocu".
export function isWarframeComm(comm: string): boolean {
  return comm.trim().toLowerCase().startsWith("warframe.x64");
}

function findWarframePid(): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  let best: number | null = null;
  let bestPages = 0;
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (!isWarframeComm(fs.readFileSync(`/proc/${e}/comm`, "utf8"))) continue;
      // A zombie Warframe.x64.ex stays in /proc beside the live game with 0 resident
      // pages. Taking the largest set also avoids the launcher's -applet: copy.
      const pages = Number(fs.readFileSync(`/proc/${e}/statm`, "utf8").split(" ")[1]) || 0;
      if (pages > bestPages) {
        best = Number(e);
        bestPages = pages;
      }
    } catch {
      // process exited between readdir and read
    }
  }
  return best;
}

interface AuthzResult {
  authz: string | null;
  // "ok-Nx", "process-not-found", "mem-open-EACCES", "crumbs-not-found"
  reason: string;
}

/** Walks the game's private writable memory through /proc/<pid>/mem, read-only. */
export async function scanGameMemoryLinux(visitor: MemoryScanVisitor): Promise<LinuxMemoryScan> {
  const pid = findWarframePid();
  if (!pid) return { failure: "process-not-found", regions: 0, bytes: 0 };

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(`/proc/${pid}/mem`, "r");
  } catch (e) {
    return {
      failure: `mem-open-${(e as NodeJS.ErrnoException).code}`,
      regions: 0,
      bytes: 0,
    };
  }

  const buf = Buffer.allocUnsafe(CHUNK);
  let chunkNo = 0;
  let regions = 0;
  let bytes = 0;
  let maps: string[] = [];
  let widened = false;

  const scanPass = async (lines: string[], widen: boolean) => {
    for (const region of scannableRegions(lines, widen)) {
      regions += 1;
      for (let addr = region.start; addr < region.end; addr += CHUNK - SCAN_OVERLAP) {
        const len = Math.min(CHUNK, region.end - addr);
        let n: number;
        try {
          ({ bytesRead: n } = await fh.read(buf, 0, len, addr));
        } catch {
          continue; // uncommitted / guard page
        }
        if (!n) continue;
        bytes += n;
        visitor.chunk(buf.subarray(0, n), addr, region);
        if (++chunkNo % 8 === 0) await new Promise((r) => setImmediate(r));
      }
    }
  };

  const reader: ProcessMemoryReader = {
    async read(address, out) {
      try {
        return (await fh.read(out, 0, out.length, address)).bytesRead;
      } catch {
        return 0;
      }
    },
    readableSpan(address, limit) {
      return spanAround(scannableRegions(maps, widened), address, limit);
    },
  };

  try {
    maps = (await fs.promises.readFile(`/proc/${pid}/maps`, "utf8")).split("\n");
    await scanPass(maps, false);
    if (visitor.wantsWiderScan?.()) {
      log.info("No match in anonymous memory - widening to private file-backed regions");
      widened = true;
      // Anonymous regions were scanned above; rescanning them would double-count hits.
      await scanPass(
        maps.filter((line) => scannableRegionFromMapsLine(line) === null),
        true,
      );
    }
    await visitor.finish?.(reader);
  } finally {
    await fh.close();
  }
  return { failure: null, regions, bytes };
}

// Scan the running game's memory and return its ?accountId=...&nonce=... query.
// Async + chunked so the ~GBs of committed memory never block the main thread.
export async function readGameAuthz(): Promise<AuthzResult> {
  const tally = createAuthzTally();
  const diagnostics = createAuthzScanDiagnostics();
  let markerHits = 0;
  const scan = await scanGameMemoryLinux({
    chunk: (view) => {
      markerHits += scanBufferForAuthzTally(view, tally, diagnostics);
    },
    wantsWiderScan: () => tally.url.size === 0,
  });
  if (scan.failure) return { authz: null, reason: scan.failure };

  const scanned = `${scan.regions} regions, ${Math.round(scan.bytes / (1024 * 1024))} MB`;
  const { counts, source } = selectAuthzCounts(tally);
  if (counts.size === 0) {
    // Same breakdown the Windows scan reports: markers with no usable string
    // means the shape changed, no markers at all means we looked in the wrong place.
    log.warn(
      `No auth crumbs found: markers=${markerHits}, scanned=${scanned}, ` +
        `rejects=${JSON.stringify(diagnostics)}`,
    );
    return { authz: null, reason: "crumbs-not-found" };
  }
  const { authz, hits, ambiguous } = bestAuthz(counts);
  if (ambiguous) {
    log.warn(`Multiple auth matches share the highest frequency (${hits}) - refusing all`);
    return { authz: null, reason: "crumbs-ambiguous" };
  }
  if (counts.size > 1)
    log.warn(`Multiple distinct auth matches (${counts.size}) - using the most frequent`);
  log.info(`Auth match found ${hits}x via ${source} (scanned ${scanned})`);
  return { authz, reason: `ok-${hits}x` };
}
