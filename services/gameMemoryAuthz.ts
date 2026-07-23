// Linux-only: read Warframe's accountId+nonce from the Proton game's memory via
// /proc/<pid>/mem, so inventory needs no external helper. Sainan's helper wants
// 3 identical copies of the auth string (false-positive guard) which Proton's
// heap does not keep - we take the most frequent well-formed match instead.
import fs from "node:fs";

import { withScope } from "./logger";

const log = withScope("gameMemory");

const NEEDLE = Buffer.from("?accountId=");
const CHUNK = 16 * 1024 * 1024;
// An auth string is <70 bytes; overlap chunks so a match can't split across them.
const OVERLAP = 256;
const ACCOUNT_ID_LEN = 24; // DE account ids are 24-hex Mongo ObjectIds
const NONCE_SEP = "&nonce=";
const MAX_NONCE_DIGITS = 24;

// Parse the auth string starting at a "?accountId=" hit, or null if malformed.
export function parseAuthzAt(view: Buffer, at: number): string | null {
  const idStart = at + NEEDLE.length;
  const idEnd = idStart + ACCOUNT_ID_LEN;
  if (idEnd + NONCE_SEP.length >= view.length) return null;
  const accountId = view.toString("latin1", idStart, idEnd);
  if (!/^[0-9a-f]{24}$/.test(accountId)) return null;
  if (view.toString("latin1", idEnd, idEnd + NONCE_SEP.length) !== NONCE_SEP) return null;
  let p = idEnd + NONCE_SEP.length;
  let nonce = "";
  while (p < view.length && nonce.length < MAX_NONCE_DIGITS) {
    const c = view[p];
    if (c < 0x30 || c > 0x39) break; // not a digit
    nonce += String.fromCharCode(c);
    p++;
  }
  if (nonce.length === 0) return null;
  return `?accountId=${accountId}&nonce=${nonce}`;
}

// Tally every well-formed auth string in a buffer into counts.
export function scanBufferForAuthz(view: Buffer, counts: Map<string, number>): void {
  let idx = 0;
  while ((idx = view.indexOf(NEEDLE, idx)) !== -1) {
    const authz = parseAuthzAt(view, idx);
    if (authz) counts.set(authz, (counts.get(authz) ?? 0) + 1);
    idx += NEEDLE.length;
  }
}

// Pick the most frequently seen match (ties resolve to the first seen).
export function bestAuthz(counts: Map<string, number>): { authz: string | null; hits: number } {
  let authz: string | null = null;
  let hits = 0;
  for (const [k, v] of counts) {
    if (v > hits) {
      authz = k;
      hits = v;
    }
  }
  return { authz, hits };
}

function findWarframePid(): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      // comm truncates to 15 chars, but still contains "warframe".
      if (fs.readFileSync(`/proc/${e}/comm`, "utf8").toLowerCase().includes("warframe")) {
        return Number(e);
      }
    } catch {
      // process exited between readdir and read
    }
  }
  return null;
}

interface AuthzResult {
  authz: string | null;
  // "ok-Nx", "process-not-found", "mem-open-EACCES", "crumbs-not-found"
  reason: string;
}

// Scan the running game's memory and return its ?accountId=...&nonce=... query.
// Async + chunked so the ~GBs of committed memory never block the main thread.
export async function readGameAuthz(): Promise<AuthzResult> {
  const pid = findWarframePid();
  if (!pid) return { authz: null, reason: "process-not-found" };

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(`/proc/${pid}/mem`, "r");
  } catch (e) {
    return { authz: null, reason: `mem-open-${(e as NodeJS.ErrnoException).code}` };
  }

  const counts = new Map<string, number>();
  const buf = Buffer.allocUnsafe(CHUNK);
  let chunkNo = 0;
  try {
    const maps = await fs.promises.readFile(`/proc/${pid}/maps`, "utf8");
    for (const line of maps.split("\n")) {
      const m = line.match(/^([0-9a-f]+)-([0-9a-f]+) (\S{4})/);
      if (!m || m[3][0] !== "r") continue; // readable regions only
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue;
      for (let addr = start; addr < end; addr += CHUNK - OVERLAP) {
        const len = Math.min(CHUNK, end - addr);
        let n = 0;
        try {
          ({ bytesRead: n } = await fh.read(buf, 0, len, addr));
        } catch {
          continue; // uncommitted / guard page
        }
        if (!n) continue;
        scanBufferForAuthz(buf.subarray(0, n), counts);
        if (++chunkNo % 8 === 0) await new Promise((r) => setImmediate(r));
      }
    }
  } finally {
    await fh.close();
  }

  if (counts.size === 0) return { authz: null, reason: "crumbs-not-found" };
  const { authz, hits } = bestAuthz(counts);
  if (counts.size > 1) log.warn(`Multiple distinct auth matches (${counts.size}) - using the most frequent`);
  return { authz, reason: `ok-${hits}x` };
}
