import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { DebugLineGate } from "./debugLineFilter";

const log = withScope("protonDebugstr");

/** Warframe's Steam app id - names Proton's default log file. */
const WARFRAME_STEAM_APP_ID = "230410";
// Newer Proton builds append their version: steam-230410-cachyos-11.0-20261015-native.log.
const PROTON_LOG_NAME_RE = new RegExp(`^steam-${WARFRAME_STEAM_APP_ID}(?:-.+)?\\.log$`);
const POLL_INTERVAL_MS = 250;
const RESOLVE_INTERVAL_MS = 2000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_READ_LOOPS_PER_TICK = 8;
// Require recent growth so a stale Proton log cannot suppress file polling.
const ACTIVE_WINDOW_MS = 30_000;

// Each Proton version logs to its own file, so the last-written one is the current launch.
function newestProtonLog(home: string): string | null {
  let newest: { file: string; mtimeMs: number } | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!PROTON_LOG_NAME_RE.test(name)) continue;
    const file = path.join(home, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && (newest === null || stat.mtimeMs > newest.mtimeMs)) {
        newest = { file, mtimeMs: stat.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return newest?.file ?? null;
}

export function resolveProtonLogPath(home = os.homedir()): string {
  const override = process.env.WFHELPER_PROTON_LOG?.trim();
  if (override) return override;
  return newestProtonLog(home) ?? path.join(home, `steam-${WARFRAME_STEAM_APP_ID}.log`);
}

// Support both modern warn:seh and legacy trace:debugstr escaped payloads.
const DEBUGSTR_OPEN_RE = /(?:trace|warn):(?:debugstr|seh):OutputDebugString[AW]\s+(L?)"/;

interface ParsedDebugstr {
  text: string;
  // Wine cuts messages at ~290 chars and appends "..." after the closing quote.
  truncated: boolean;
}

function isHexDigit(c: string | undefined): boolean {
  return c !== undefined && /[0-9a-fA-F]/.test(c);
}

// ANSI payloads escape non-printables per byte - collect bytes, then decode
// utf8 so multi-byte glyphs (platform markers, U+E000) match the DBWIN path.
function unescapeAnsi(esc: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c !== "\\") {
      bytes.push(esc.charCodeAt(i));
      continue;
    }
    const next = esc[i + 1];
    if (next === "n") {
      bytes.push(10);
      i += 1;
    } else if (next === "r") {
      bytes.push(13);
      i += 1;
    } else if (next === "t") {
      bytes.push(9);
      i += 1;
    } else if (next === '"') {
      bytes.push(34);
      i += 1;
    } else if (next === "\\") {
      bytes.push(92);
      i += 1;
    } else if (next === "x" && isHexDigit(esc[i + 2]) && isHexDigit(esc[i + 3])) {
      bytes.push(parseInt(esc.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      bytes.push(92); // stray backslash - keep literally
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// Wide payloads escape non-printables as UTF-16 code units (up to 4 hex digits).
function unescapeWide(esc: string): string {
  let out = "";
  for (let i = 0; i < esc.length; i++) {
    const c = esc[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = esc[i + 1];
    if (next === "n") {
      out += "\n";
      i += 1;
    } else if (next === "r") {
      out += "\r";
      i += 1;
    } else if (next === "t") {
      out += "\t";
      i += 1;
    } else if (next === '"') {
      out += '"';
      i += 1;
    } else if (next === "\\") {
      out += "\\";
      i += 1;
    } else if (next === "x" && isHexDigit(esc[i + 2]) && isHexDigit(esc[i + 3])) {
      let digits = 2;
      if (isHexDigit(esc[i + 4]) && isHexDigit(esc[i + 5])) digits = 4;
      out += String.fromCharCode(parseInt(esc.slice(i + 2, i + 2 + digits), 16));
      i += 1 + digits;
    } else {
      out += "\\";
    }
  }
  return out;
}

/** Extract the OutputDebugString payload from a wine trace line, or null. */
export function parseWineDebugstr(raw: string): ParsedDebugstr | null {
  const m = DEBUGSTR_OPEN_RE.exec(raw);
  if (!m) return null;
  const open = m.index + m[0].length;
  const trimmed = raw.trimEnd();
  const close = trimmed.lastIndexOf('"');
  if (close < open) return null; // no closing quote - malformed, skip
  const payload = trimmed.slice(open, close);
  return {
    text: m[1] === "L" ? unescapeWide(payload) : unescapeAnsi(payload),
    truncated: trimmed.slice(close + 1) === "...",
  };
}

/** Treat truncation as a fresh session and ignore an existing stale file on attach. */
export class ProtonLogTail {
  private offset = 0;
  private remainder = "";
  private fd: number | null = null;
  private state: "init" | "tailing" | "missing" = "init";
  private lastGrowthAt = 0;
  private logPath: string | null = null;
  private resolvedAt = 0;
  private readonly resolvePath: () => string;
  private readonly buffer = Buffer.alloc(MAX_READ_BYTES);

  constructor(
    logPath: string | (() => string),
    private readonly onLine: (raw: string) => void,
  ) {
    this.resolvePath = typeof logPath === "string" ? () => logPath : logPath;
  }

  // The log can move to a new file when Proton starts a launch under another version.
  private currentPath(now: number): string {
    if (this.logPath === null || now - this.resolvedAt >= RESOLVE_INTERVAL_MS) {
      const next = this.resolvePath();
      this.resolvedAt = now;
      if (this.logPath !== null && next !== this.logPath) {
        log.info("[ProtonLog] switching to", next);
        this.closeFd();
        this.offset = 0;
        this.remainder = "";
      }
      this.logPath = next;
    }
    return this.logPath;
  }

  /** True while the log grew recently - the liveness signal for isActive. */
  isFresh(now: number): boolean {
    return this.lastGrowthAt > 0 && now - this.lastGrowthAt < ACTIVE_WINDOW_MS;
  }

  poll(now = Date.now()): void {
    const logPath = this.currentPath(now);
    let size: number;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      // Log absent (or deleted). A later appearance is a fresh Proton launch.
      this.closeFd();
      this.state = "missing";
      this.offset = 0;
      this.remainder = "";
      return;
    }

    if (this.state === "init") {
      this.offset = size;
      this.state = "tailing";
      return;
    }
    this.state = "tailing";

    if (size < this.offset) {
      this.closeFd();
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) return;

    try {
      if (this.fd == null) this.fd = fs.openSync(logPath, "r");
      let loops = 0;
      while (loops < MAX_READ_LOOPS_PER_TICK) {
        const bytesRead = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, this.offset);
        if (!bytesRead) {
          // Path says there is more but the fd sees EOF - the file was
          // replaced under us; reopen on the next poll.
          this.closeFd();
          break;
        }
        this.offset += bytesRead;
        this.lastGrowthAt = now;
        this.consume(this.buffer.subarray(0, bytesRead).toString("utf8"));
        if (bytesRead < this.buffer.length) break;
        loops += 1;
      }
    } catch (error) {
      this.closeFd();
      log.error("[ProtonLog] read error:", normalizeErrorMessage(error));
    }
  }

  close(): void {
    this.closeFd();
    this.remainder = "";
  }

  private closeFd(): void {
    if (this.fd == null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore close errors
    }
    this.fd = null;
  }

  private consume(chunk: string): void {
    const merged = this.remainder + chunk;
    const lines = merged.split(/\r?\n/);
    this.remainder = lines.pop() || "";
    for (const line of lines) {
      if (line) this.onLine(line);
    }
  }
}

let tail: ProtonLogTail | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Mirrors isDbwinActive(): true while real-time lines are flowing. */
export function isProtonDebugstrActive(): boolean {
  return tail !== null && tail.isFresh(Date.now());
}

export function startProtonDebugstrMonitor(onLine: (line: string) => void): void {
  if (tail) return;

  const logPath = resolveProtonLogPath();
  const gate = new DebugLineGate();
  tail = new ProtonLogTail(resolveProtonLogPath, (raw) => {
    const parsed = parseWineDebugstr(raw);
    if (!parsed) return;
    // Wine cuts long messages (trade dialog blobs) - the file poll delivers
    // those complete later; only forward payloads seen in full.
    if (parsed.truncated) return;
    if (!gate.wants(parsed.text, Date.now())) return;
    onLine(parsed.text);
  });

  if (fs.existsSync(logPath)) {
    log.info("[ProtonLog] tailing", logPath, "for real-time triggers");
  } else {
    log.info(
      "[ProtonLog] no log at",
      logPath,
      "- real-time triggers off; add PROTON_LOG=1 %command% to Warframe's Steam launch options",
    );
  }

  pollTimer = setInterval(() => tail?.poll(), POLL_INTERVAL_MS);
  if (typeof (pollTimer as NodeJS.Timeout)?.unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
  tail.poll();
}

export function stopProtonDebugstrMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tail) {
    tail.close();
    tail = null;
  }
}
