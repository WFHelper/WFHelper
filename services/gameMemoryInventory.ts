import { hasInventoryShape } from "../config/shared/inventoryPayload";
import {
  scanGameMemoryLinux,
  type MemoryScanVisitor,
  type ProcessMemoryReader,
  type ScannableRegion,
} from "./gameMemoryAuthz";
import { isPrivateReadWriteRegion, scanGameMemoryWin } from "./gameMemoryWin";

const ANCHOR = Buffer.from('"LastInventorySync"');
const SYNC_ID_AFTER_ANCHOR = /^\s*:\s*\{\s*"\$oid"\s*:\s*"([0-9a-f]{24})"/;
const SYNC_ID_WINDOW = 64;
const ANCHOR_WITH_ID = ANCHOR.length + SYNC_ID_WINDOW;
// A 2026-09 inventory is 0.9 MB with this key 3 KB before its end.
const MAX_INVENTORY_JSON_BYTES = 8 * 1024 * 1024;
const MAX_BYTES_AFTER_ANCHOR = 1024 * 1024;
const MAX_CANDIDATES = 256;
const MAX_EXTRACTIONS_PER_PROCESS = 8;
const MAX_REPORTED_SYNC_TIMES = 10;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

type SyncIdParse = { syncId: string } | { syncId: null; truncated: boolean };

function parseSyncIdAt(view: Buffer, at: number): SyncIdParse {
  const from = at + ANCHOR.length;
  const to = Math.min(view.length, from + SYNC_ID_WINDOW);
  const match = SYNC_ID_AFTER_ANCHOR.exec(view.toString("latin1", from, to));
  if (match) return { syncId: match[1] };
  return { syncId: null, truncated: to - from < SYNC_ID_WINDOW };
}

/** Seconds in the ObjectId's first four bytes, as epoch milliseconds. */
export function syncIdTime(syncId: string): number {
  return parseInt(syncId.slice(0, 8), 16) * 1000;
}

export function inventorySyncId(inventory: unknown): string | null {
  if (!inventory || typeof inventory !== "object") return null;
  const sync = (inventory as Record<string, unknown>).LastInventorySync;
  if (!sync || typeof sync !== "object") return null;
  const oid = (sync as Record<string, unknown>).$oid;
  return typeof oid === "string" && /^[0-9a-f]{24}$/.test(oid) ? oid : null;
}

function isEscaped(buf: Buffer, quoteAt: number, floor: number): boolean {
  let slashes = 0;
  for (let i = quoteAt - 1; i >= floor && buf[i] === BACKSLASH; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function findObjectStart(buf: Buffer, keyAt: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = keyAt - 1; i >= 0; i -= 1) {
    const byte = buf[i];
    if (inString) {
      if (byte === QUOTE && !isEscaped(buf, i, 0)) inString = false;
      else if (byte < 0x20) return null;
      continue;
    }
    if (byte === QUOTE) {
      if (isEscaped(buf, i, 0)) return null;
      inString = true;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth += 1;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      if (depth === 0) return byte === OPEN_BRACE ? i : null;
      depth -= 1;
    } else if ((byte < 0x20 && !isJsonWhitespace(byte)) || byte >= 0x7f) {
      return null;
    }
  }
  return null;
}

function findObjectEnd(buf: Buffer, start: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < buf.length; i += 1) {
    const byte = buf[i];
    if (inString) {
      if (byte === BACKSLASH) i += 1;
      else if (byte === QUOTE) inString = false;
      else if (byte < 0x20) return null;
      continue;
    }
    if (byte === QUOTE) {
      inString = true;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth += 1;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if ((byte < 0x20 && !isJsonWhitespace(byte)) || byte >= 0x7f) {
      return null;
    }
  }
  return null;
}

function findInventoryObject(buf: Buffer, anchorAt: number): { start: number; end: number } | null {
  const start = findObjectStart(buf, anchorAt);
  if (start === null) return null;
  const end = findObjectEnd(buf, start);
  if (end === null || end <= anchorAt) return null;
  return { start, end };
}

interface Candidate {
  address: number;
  region: ScannableRegion;
  syncId: string;
}

interface GameInventoryCopy {
  syncId: string;
  syncTime: number;
  inventory: Record<string, unknown>;
}

/** What one walk found; counts and times only, so the whole object is safe to log. */
interface InventoryScanStats {
  copies: number;
  syncTimes: number[];
  extractions: number;
  failedExtractions: number;
}

interface InventoryCollector extends MemoryScanVisitor {
  result(): { newest: GameInventoryCopy | null; stats: InventoryScanStats };
}

async function extractCandidate(
  reader: ProcessMemoryReader,
  candidate: Candidate,
): Promise<GameInventoryCopy | null> {
  // A copy measured in 2026-09 spanned several adjacent 64 KB regions.
  const readable =
    reader.readableSpan?.(candidate.address, MAX_INVENTORY_JSON_BYTES) ?? candidate.region;
  const low = Math.max(readable.start, candidate.address - MAX_INVENTORY_JSON_BYTES);
  const high = Math.min(readable.end, candidate.address + MAX_BYTES_AFTER_ANCHOR);
  const anchorAt = candidate.address - low;
  if (high - low < anchorAt + ANCHOR.length) return null;
  const buf = Buffer.allocUnsafe(high - low);
  const bytesRead = await reader.read(low, buf);
  if (bytesRead < anchorAt + ANCHOR.length) return null;
  const view = buf.subarray(0, bytesRead);
  if (!view.subarray(anchorAt, anchorAt + ANCHOR.length).equals(ANCHOR)) return null;
  const span = findInventoryObject(view, anchorAt);
  if (!span) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(view.toString("utf8", span.start, span.end));
  } catch {
    return null;
  }
  if (!hasInventoryShape(parsed)) return null;
  // The anchor may have been rewritten between the walk and this read.
  if (inventorySyncId(parsed) !== candidate.syncId) return null;
  return {
    syncId: candidate.syncId,
    syncTime: syncIdTime(candidate.syncId),
    inventory: parsed as Record<string, unknown>,
  };
}

function keepNewest(candidates: Candidate[], next: Candidate): void {
  if (candidates.length < MAX_CANDIDATES) {
    candidates.push(next);
    return;
  }
  let oldest = 0;
  for (let i = 1; i < candidates.length; i += 1) {
    if (syncIdTime(candidates[i].syncId) < syncIdTime(candidates[oldest].syncId)) oldest = i;
  }
  if (syncIdTime(next.syncId) > syncIdTime(candidates[oldest].syncId)) candidates[oldest] = next;
}

/** Collects `LastInventorySync` anchors during a walk and parses the newest complete copy. */
export function createInventoryCollector(): InventoryCollector {
  let candidates: Candidate[] = [];
  let seen = new Set<number>();
  let newest: GameInventoryCopy | null = null;
  const syncTimes = new Set<number>();
  let copies = 0;
  let extractions = 0;
  let failedExtractions = 0;
  // The previous chunk's tail, joined to the next chunk's head when that starts where it ended.
  const joint = Buffer.alloc(ANCHOR_WITH_ID * 2);
  let tailLength = 0;
  let tailEnd = -1;
  let tailRegion: ScannableRegion | null = null;

  function collect(view: Buffer, address: number, region: ScannableRegion, before: number): void {
    let idx = 0;
    while ((idx = view.indexOf(ANCHOR, idx)) !== -1 && idx < before) {
      const at = idx;
      idx += ANCHOR.length;
      if (seen.has(address + at)) continue;
      const parsed = parseSyncIdAt(view, at);
      // A cut-off id is read again from the next chunk's overlap or joint.
      if (parsed.syncId === null && parsed.truncated) continue;
      seen.add(address + at);
      if (parsed.syncId === null) continue;
      copies += 1;
      syncTimes.add(syncIdTime(parsed.syncId));
      keepNewest(candidates, { address: address + at, region, syncId: parsed.syncId });
    }
  }

  return {
    chunk(view, address, region) {
      if (tailRegion && tailLength > 0 && address === tailEnd) {
        const head = view.copy(joint, tailLength, 0, ANCHOR_WITH_ID);
        const joined = joint.subarray(0, tailLength + head);
        collect(joined, tailEnd - tailLength, tailRegion, tailLength);
      }
      collect(view, address, region, view.length);
      tailLength = view.copy(joint, 0, Math.max(0, view.length - ANCHOR_WITH_ID));
      tailEnd = address + view.length;
      tailRegion = region;
    },
    wantsWiderScan() {
      return copies === 0;
    },
    async finish(reader) {
      const ordered = candidates.sort((a, b) => syncIdTime(b.syncId) - syncIdTime(a.syncId));
      candidates = [];
      seen = new Set();
      tailRegion = null;
      let attempts = 0;
      for (const candidate of ordered) {
        if (newest && syncIdTime(candidate.syncId) <= newest.syncTime) break;
        if (attempts >= MAX_EXTRACTIONS_PER_PROCESS) break;
        attempts += 1;
        extractions += 1;
        const copy = await extractCandidate(reader, candidate);
        if (copy) {
          newest = copy;
          break;
        }
        failedExtractions += 1;
      }
    },
    result() {
      return {
        newest,
        stats: {
          copies,
          syncTimes: [...syncTimes].sort((a, b) => b - a).slice(0, MAX_REPORTED_SYNC_TIMES),
          extractions,
          failedExtractions,
        },
      };
    },
  };
}

type GameInventoryReadStatus =
  | "ok"
  | "process-not-found"
  | "access-denied"
  | "not-found"
  | "unavailable";

export interface GameInventoryRead extends InventoryScanStats {
  status: GameInventoryReadStatus;
  newest: GameInventoryCopy | null;
  scanMs: number;
  scannedMb: number;
  skippedMb: number;
  regions: number;
}

function statusFromFailure(failure: string): GameInventoryReadStatus {
  if (failure === "process-not-found") return "process-not-found";
  if (failure === "mem-open-noapi") return "unavailable";
  return "access-denied";
}

/** Reads the game's own resident inventory JSON, read-only, without any request to DE. */
export async function readGameInventory(): Promise<GameInventoryRead> {
  const started = Date.now();
  const collector = createInventoryCollector();
  let failure: string | null;
  let bytes = 0;
  let skippedBytes = 0;
  let regions = 0;
  if (process.platform === "win32") {
    const scan = await scanGameMemoryWin(collector, isPrivateReadWriteRegion, undefined, true);
    ({ failure, bytes, skippedBytes, regions } = scan);
  } else if (process.platform === "linux") {
    const scan = await scanGameMemoryLinux(collector);
    ({ failure, bytes, regions } = scan);
  } else {
    failure = "mem-open-noapi";
  }
  const { newest, stats } = collector.result();
  return {
    status: failure ? statusFromFailure(failure) : newest ? "ok" : "not-found",
    newest,
    ...stats,
    scanMs: Date.now() - started,
    scannedMb: Math.round(bytes / (1024 * 1024)),
    skippedMb: Math.round(skippedBytes / (1024 * 1024)),
    regions,
  };
}
